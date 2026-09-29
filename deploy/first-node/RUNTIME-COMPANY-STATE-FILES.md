# Company state files

Status: the shared parser is built (F2-0, #421). The vision and agents are indexed in the database
(F2-1, migration 20260928249020), for `folder-v2` companies only, so nothing reads or writes these
files in production yet. This is workstream F2 of the Rebuild Map: company state moves out of database
rows into the company folder of contract 5.6. It defines the fixed format of each structured
file, the database index each one feeds, how a refused file is reported, and what the runtime
and the web app read. The storage core that saves the files and calls these checks is
[RUNTIME-COMPANY-FOLDER-CORE.md](RUNTIME-COMPANY-FOLDER-CORE.md) (F1). Where this document and
the contract differ, the contract governs.

Founder page: https://claude.ai/artifact/PUxd7wuJsa9zezcFuNbjNx (same content in plain words,
with three decisions asked, marked **pending** below).

Everything here applies only to `folder-v2` companies (core §1). `snapshot-v1` companies keep
today's tables and tools until the reset, and nothing is migrated (layout amendment, 28
September 2026).

## 1. The structured files

| Path | Kind | Settings block |
| --- | --- | --- |
| `vision/vision.md` | vision | none: the first line is `# <company name>` |
| `agents/sections.md` | sections | none: `## <section>` then `- <id> …` lines |
| `agents/<handle>/agent.md` | agent | yes |
| `agents/groups/<handle>/group.md` | group | yes |
| `agents/<handle>/routines/<name>.md` | routine | yes |
| `agents/<handle>/todos/<name>.md` | todo | yes |
| `agents/<handle>/todos/<todo>/<worker>/brief.md` | worker-brief | yes (platform-only) |
| `agents/<handle>/todos/<todo>/<worker>/results.md` | worker-results | yes (platform-only) |
| `connections/<name>.md` | connection | yes (platform-only settings) |
| `rules/<name>.md` | rule | yes |

A path's kind is decided on the folder's key (`companyPathKey`, the same NFKC-casefold as
`qorpera_company_path_key`, 20260828005000), because two spellings with one key are one entry:
`ＡＧＥＮＴＳ/anna/agent.md` is Anna's `agent.md`. The database classifies on `key_text` and
refuses a unit on a structured key that carries no parse. JavaScript and Postgres may case-map a
few characters differently (`İ`); such a path then fails closed in the database, and the
comparison test below includes these spellings. Every other file is ordinary: one
pattern match and nothing else. Files nested deeper (a note in `routines/notes/`, a worker's
output next to its brief) are ordinary. Core §5's list gains `vision/vision.md` and the two
worker files.

The parser is `@qorpera/cloud-client/company-state-files` (`companyStatePath`,
`parseCompanyStateFile`, the canonical `write*File` writers and `setCompanyStateSettings`).
The runtime, the web app, the object gateway and the folder service all use it. The database
repeats the pattern table in `qorpera_structured_path_kind(path)`, and a test compares the two
on one list of paths, compatibility spellings included.

### Names

Folder and file names follow contract 5.6 as written (not only as keys): lowercase `a–z`,
digits and single hyphens, at most 64 characters, and a lowercase `.md` extension. The whole
path of a structured file is written exactly as its key, so `agents/anna/Agent.md` or a
compatibility spelling is refused with the spelling to use. The rule covers agent and group
folders, routine, todo, rule and connection files, and todo and worker folders.

These path checks are `companyStatePathProblems(path, folder)`. They need no text, so the
database runs the same list, and the comparison test covers both. `decide` runs them on the
path an entry is actually stored under, its parent folder's stored spelling included:
- for every file a unit writes;
- for every structured file a move or rename carries, at its new path;
- for every folder a unit creates or renames at a structured place: `agents/<h>`,
  `agents/groups/<g>`, `agents/<h>/routines`, `agents/<h>/todos`, `agents/<h>/todos/<t>` and
  `agents/<h>/todos/<t>/<w>`.

So a rename can never leave a file that no later save could pass. Renaming
`routines/daily.md` to `Daily report.md`, or case-only to `Daily.md`, is refused. So is
creating an ordinary folder `agents/anna/Routines/`, which would give a later routine the
wrong spelling. A subtree move checks every folder it carries whose new path is a structured
place, not only the moved folder itself: an ordinary folder holding `Todos/`, moved to
`agents/x`, is refused. A failed path check refuses the unit as `structured_invalid` with
`name` problems.

`companyStateName` makes a name from a display name: NFC first, then æ → ae, ø → oe,
å → aa, accents dropped, spaces to hyphens, the rest dropped. `freeCompanyStateName` adds `-2`,
`-3` for a taken name and uses the fallback (`agent`, `group`) when nothing is left. `groups`
is reserved under `agents/`. Uniqueness is checked by the database on the key.

Today's routine, todo and worker keys allow `.`, `_` and up to 96 characters
(20260922170000:24,48; 20260920000000:30). The thin writers (§5) derive file names with
`freeCompanyStateName` instead.

### The settings block

A strict subset of YAML 1.2. A YAML 1.2 core-schema reader reads the same values from any file
the parser accepts. YAML 1.1 readers (js-yaml, PyYAML) may read some plain values differently:
an unquoted instant as a timestamp, or, depending on the reader, forms such as `yes`, `8:00`,
`010`, `0b101`, `0x1F` or `1_000` as a boolean or a number. The canonical writers and
`companyStateValue` quote forms like these, but leave a canonical instant plain.

- The file starts with a line `---`; the block ends at the next line `---`. A UTF-8
  byte-order mark and CRLF line ends are accepted.
- One `key: value` per line. Keys are `[a-z][a-z0-9_]*`. Each kind has a closed set of keys.
  An unknown or repeated key is refused. So is a key given with no value (`effort:`); remove
  the line instead.
- **Values:**
  - plain text;
  - `"double-quoted"`, with escapes `\" \\ \/ \b \f \n \r \t \uXXXX` and surrogate pairs only
    as pairs;
  - `'single-quoted'`;
  - a one-line list `[a, b]`;
  - or a key with no value, followed by `- item` lines at one indentation (zero allowed). A
    list key with no items is refused, because YAML reads it as null; an empty list is `[]`.
- **Notes:** `#` after a space starts a note. Tabs, every other control character (a
  carriage return inside a line included) and U+2028/U+2029 are refused anywhere in the block,
  notes included.
- **Refused shapes:**
  - flow maps, anchors, aliases, tags and block scalars (`|`, `>`);
  - a plain value that starts with a YAML indicator (`[ ] { } , # & * ! | > % @` `` ` ``, quotes,
    or `- ? :` before a space), or that contains `": "`;
  - a flow indicator inside a one-line list's plain item;
  - list items that do not line up;
  - a plain value in a text field that YAML reads as something other than text (`true`,
    `null`, `42`, `.5`, `0o17`, …): "put it in double quotes";
  - a value with spaces at either end. Only U+0020 counts as a space in the settings: a
    no-break or other Unicode space is kept as YAML keeps it, and refused at a value's edge;
  - a quoted whole number.
- **Types are the kind's:**
  - ids: lowercase UUIDs;
  - whole numbers;
  - UTC instants `YYYY-MM-DDTHH:MM[:SS[.ffffff]]Z` that name a real time from year 0001. The
    parse returns the canonical form: seconds always, a fraction only when it is not zero. So
    a new spelling of one instant is not a new value. Instants compare to the microsecond;
  - clock times `HH:MM`;
  - days `mon`…`sun`;
  - IANA time zones. The parser checks only their shape, since engines disagree on aliases:
    each part starts with a capital letter or a digit. The few list entries of another shape,
    such as `posixrules`, are not accepted. The database then refuses a name that is not in its
    exact-case list (`structured_rule`). Editors may show `companyStateTimeZoneProblem`, the
    engine's opinion, as a hint; it also suggests the right case.
- **One-line text fields** refuse every C0 and C1 control character (tab included, as Postgres
  `[[:cntrl:]]`) and U+2028/U+2029. Limits count characters or bytes exactly as the database
  column does (see each kind).
- **The body** is everything after the closing line. The file keeps it as written. The parse
  and the index keep it trimmed at both ends, as the database columns require.

A structured file is at most 64 KiB (core §5). The same bytes always give the same parse or the
same problems. A refused file reports at most 50 problems, then one closing "and K more
problems" (`line` and `key` null, the code of the first problem left out). Input quoted in a
message or a problem's `key` is cut to 100 characters, so problems stay small next to
the file. A place that shows a missing-id problem may offer a fresh id
(`newCompanyStateId`), but the parse never contains one, so an operation key replays.

The canonical writers always produce a file the parser reads:
- A value the format refuses (a tab in a name) is written escaped, and the parse then refuses
  it with its reason.
- A heading name (the company, a section) that is not one line is refused by the writer. A
  heading name ending in `#` gets a closing `#`, so it reads back the same.
- Names beside ids, for reading, are made one line.

`setCompanyStateSettings` changes typed settings (text, whole numbers, lists) and keeps every
other byte: the BOM, each line's own line ending, other lines' notes, blank lines and the body.
A changed key keeps its place, and its own note goes. A key with no value on its line takes its
list lines with it; a key with a value never takes the lines below it.

## 2. Formats

### `vision/vision.md`

No settings block. The first line with text is `# ` and the company's name, 1–120 characters.
A CommonMark closing run of `#` is dropped. That name is the company's name everywhere, so
renaming the company means editing that line. The rest is free. The platform seeds:

```
# <name>

## What we build
## For whom
## Why
## How we work
```

Every agent reads the file in full at every run (contract 5.6, 9.1). Refused: no `#` name
first; deleting or moving the file (seeded).

### `agents/<handle>/agent.md`

| Key | Required | Values |
| --- | --- | --- |
| `id` | yes | UUID; never changes |
| `name` | yes | 1–160 characters (`display_name`) |
| `role` | yes | 1–320 characters |
| `kind` | yes | `co-founder` or `agent` |
| `status` | yes | `active` or `archived` |
| `colour` | no | charcoal, brown, coral, orange, gold, green, teal, blue, purple, pink, gray (the app's `qorpera-<colour>` tokens) |
| `figure` | no | `STAFF_CHARACTER_IDS`: planet, acorn, flame, rocket, crown, heart, ghost |
| `model` | no | gpt-6-astra, gpt-6-sol, gpt-6-luna: used when no conversation or routine picks one |
| `effort` | no | low, medium, high; default low |
| body | yes | the instructions (today's charter), up to 32768 bytes trimmed; no control character other than tab and line breaks |

**Database rules:**
- The Co-Founder is `qorpera_company_cofounders`. Only it has `kind: co-founder`. A save that
  gives it to another agent, or takes it from the Co-Founder, is refused. So is archiving the
  Co-Founder.
- `id` never changes and is unique. A copy of an agent folder is refused.
- A new folder's name follows the naming rule and is unique.

The seeded Co-Founder has `figure: crown` and `colour: blue`.

**Review** (agent writers only, core §4):
- A new agent folder or `agent.md` (a hire) is delegation. So is a change of `status`.
- Deleting or moving the folder is deletion.
- A restricted creator's hire parks for a member (contract 14.1).

**Refused** (contract 5.6):
- deleting `agent.md` alone;
- moving an agent folder out of `agents/` or into `agents/groups/`;
- deleting the Co-Founder's folder;
- any write under `agents/` from a coding session.

A folder directly under `agents/` without an `agent.md` is not an agent. It has no index row,
but its name counts as taken.

**Pending decision 2:** a hire's first task is a todo file in the new folder. It is written in
the same `new_folder` unit as `agent.md` (§3), instead of the hidden `startupInstructions`
kickoff.

### `agents/sections.md`

No settings block.
- Lines before the first `## ` heading are free text, `###` headings included.
- Each `## <name>` is a section, in order: 1–60 characters, no controls, unique ignoring case.
  A section may be empty. `##Sales` (no space) is refused.
- Under a section, each non-blank line is `- <id>` (or `* <id>`), followed by optional words
  for reading. An id appears at most once.
- Refused with its line number: any other line under a section, a `###` heading under a
  section, an id line before the first section, and an uppercase id.

**Database rules:**
- Every id the save adds is an agent (not retired) or an open group chat of this company
  (**pending decision 1**: group chats are listed too, as #370 allows).
- An id already in the saved version is never refused, even if its agent is gone or its group
  chat is closed, so an old line never blocks a save. The index keeps its place, which the sidebar
  hides until a restore brings the agent or chat back where the file says.
- The Co-Founder is refused.
- Section names are unique ignoring case, and an id is listed once in the whole file (the parse's
  shape; the parser refuses both).

**Index:** sections in file order, matched to today's rows by name ignoring case, so a section
keeps its id when only its case changes. A section's agents and group chats share one order, as the
sidebar draws them. An id with no agent or chat at all is skipped. Agents and group chats not
listed are Unassigned, in roster order. Today's
placement positions for Unassigned are not kept. Pins and hidden agents stay member settings in the database. Not
reviewed. Deleting or moving the file is refused (seeded).

The platform seeds:

```
# Sections

Each line is an id. The words after it are only for reading.
```

### `agents/groups/<handle>/group.md`

| Key | Required | Values |
| --- | --- | --- |
| `id` | yes | UUID; the conversation follows it |
| `name` | yes | 1–256 characters |
| `subtitle` | no | up to 256 characters; `""` shows no subtitle, and no key shows "Group chat" |
| `agents` | yes | agent ids, at least two, no repeats |
| `people` | no | member ids |
| body | yes | the purpose, up to 32768 bytes trimmed |

**Database rules:**
- Only the ids a save adds are checked: they must exist and be active. An agent that is later
  archived, or a person who leaves, never blocks a later save of the file. The index keeps them
  listed as written: wakes check the agent's status and access checks the person's membership, so
  a reactivated agent or a returning member is back without another save.
- A restore has no saved version at its path, so it is compared with the chat's last file: the
  same file restores even after one of its agents was archived or a person left.
- An agent's change may add to `people` only the member its run works for (today's
  `create_group_chat` rule), because adding a person lets them read the conversation.
- The id never changes, and belongs to this folder's chat only: never to an agent, an agent's
  thread, a snapshot-v1 chat (or its `chat-<id>` key) or another folder's open chat. One change set
  carries it once. An agent never takes a conversation's id either, since `sections.md` lists both
  kinds by id.

**Index:** a new `group.md` opens a room (`chat-<id>`, no bound agent) and its conversation. An
edit sets the name, subtitle and purpose, and the conversation's title. Members follow the two
lists: anyone left out is `removed` at that version. Deleting the folder archives the room and
closes the conversation; a restore reopens both, with the same conversation.

**Review:** a new `group.md` is delegation.

**Refused:**
- deleting `group.md` alone. Deleting the folder closes the chat; its conversation stays;
- moving the folder out of `agents/groups/`.

### `connections/<name>.md`

| Key | Required | Values |
| --- | --- | --- |
| `id` | yes | the vault record's id (`qorpera_cloud_secrets.id`) |
| `service` | yes | the connector id (gmail, github, google_drive, …) |
| `account` | yes | the mailbox or login, up to 254 characters |
| `status` | yes | `connected` or `broken` |
| `actions` | yes | the catalog's operation ids every agent may use (may be empty) |
| `connected_by` | yes | member id |
| `connected_at` | yes | UTC instant |
| body | no | what the account is for, written by the company |

- **Settings:** written only by the platform (the vault's writer, core C3). A member or an agent
  may change the body only, and never creates or deletes the file.
- **Body:** company-authored.
- **Authority:** the vault and the operation grants stay in charge (contract 5.6).
- **Database rules:** the id is a company-owned vault row (`qorpera_cloud_secrets`) of this
  company and environment, and never changes. A platform write matches that row: it is active and
  its connector is the `service`. One file holds one account. A file saved before this slice is not
  trusted as the saved version until the platform writes it (the index points at its path).
- **Deleting:** only the platform deletes the file, and only once the vault record is revoked
  (refused while it is active, whether `connected` or `broken`). Disconnecting removes the file; the
  writer treats a file already missing as done.
- **Moving:** within `connections/` the index follows; out of it is a kind change (refused).
- Not reviewed.

### `rules/<name>.md`

| Key | Required | Values |
| --- | --- | --- |
| `id` | yes | UUID; review records cite it |
| `outcome` | yes | `ask-first` (`ask_first`) or `allow` (`allow_automatically`) |
| body | yes | how "When an agent wants to …" ends, as today's `when_text`: one line, 1–280 characters trimmed, no controls |

- **Who writes:** only owners and admins write `rules/` (members' commits; the core's
  `company_rules` resource scope). A card's "Always allow" writes as the answering owner or admin
  (core C3's writer; until then that path still saves a row). Agents never write it. Personal rules
  stay rows. For folder-v2 companies Settings refuses saving a company rule and removing a rule
  that comes from a file (55000): they change as file edits. A company rule saved as a row (a
  card's "Always allow" until C3) can still be removed there. The web's rules list reads
  `createdVia: folder`.
- **Database rules:** the id never changes and belongs to this file's rule only: never a personal
  rule, a row saved outside the folder, another company's or another file's rule. A file saved
  before this slice is the saved version only once the index points at its path.
- **Budget:** the company rule budget of 48 KiB (`qorpera_review_rules_assert_room`) stays a
  database rule. `decide` checks it against the rules as they are, with every rule file of the
  same unit counted by its new text, so two concurrent saves of different files can each pass and
  overshoot by at most one unit each: serializing them would take a company-wide lock.
- **Index:** a new rule inserts a company row (`created_via` `folder`, the file's id); an edit
  updates it; deleting the file archives it (review records keep citing it) and a restore brings
  it back; a move repoints it. The row's foreign key to the company row takes it `KEY SHARE`, so a
  rule save takes the company row at rank 2 first.
- Never reviewed.

### `agents/<handle>/routines/<name>.md`

**Pending decision 3:** exactly one trigger per file. F2-6 (migration 20260929310000) is built on
it; a different answer changes the parser and `qorpera_company_state_routine_trigger` only.

| Key | Required | Values |
| --- | --- | --- |
| `id` | yes | UUID: the routine id cursors and occurrences use |
| `title` | yes | 1–160 bytes |
| `status` | yes | `active`, `paused`, `concluded` ("expired" is derived by the scheduler) |
| `when` | yes | `every`, `weekly`, `window`, `once`, `file-change` (refused on `folder-v2` until core C4 brings the folder's file events) |
| `minutes` | every, window | 5–10080 |
| `starts` | every, weekly: optional | UTC instant, to the millisecond at most (what a schedule keeps) |
| `days` | weekly (required), window (optional) | list of `mon`…`sun`, at least one |
| `time` | weekly | `HH:MM` |
| `from`, `to` | window | `HH:MM`, `from` ≤ `to` |
| `months` | window: optional | list of 1–12, at least one |
| `at` | once | UTC instant; before `ends` |
| `watch` | file-change | a path in the company; a trailing `/` is dropped |
| `match` | file-change | `exact` or `subtree` |
| `timezone` | all but `every` | IANA name the database knows |
| `ends` | no | UTC instant |
| `runs` | no (not for `once`) | 1–100000 |
| `quiet` | no | `"HH:MM-HH:MM"`, start ≠ end |
| `quiet_timezone` | no | the quiet hours' zone when it differs from `timezone` (today's `quiet_time_zone`); quiet hours need one of the two |
| `effort` | no | low, medium (default), high: what runs accept today |
| `reply` | no | optional (default), required, silent |
| `conclusion` | when concluded, and only then | 1–2000 bytes |
| body | yes | what to do each time, up to 32768 bytes trimmed |

**Ownership:**
- A key of another `when` is refused by name.
- The owner is the agent whose folder holds the file. Moving the file to another agent's
  `routines/` hands the routine over.
- Who pays for a routine's runs is not in the file (the "starter pays" work, S2). A version is
  paid by the saver's own login that pays for unattended work, as today's saves are: a member's,
  or a run's requester's (the rule of `qorpera_agent_routine_sponsor`, read without its lock on
  the login). A member without one cannot save a new version. A run whose requester has none
  pins the run's login, and the routine waits (`needs_model_account`), as an agent's save does
  today. A move keeps the payer. A resume on a login that stopped paying moves to the saver's.
- The index row's `origin` is who made the first commit: `agent` for a run, else `member`.

**Versions and schedule positions:**
- A saved change of what a run pins (the agent, title, instructions, trigger with its reply, and
  effort) is a new routine version. Status, `ends`, `runs`, quiet hours and the conclusion are
  the routine row's, so pausing or timing a routine needs no login. A dynamic routine's own run
  always makes its decision a new version, even at the same `at`.
- Schedule positions follow the 2026-09-25 rules (`qorpera_routine_version_schedule_position`):
  the same timing keeps its position, and a slot the scheduler queued for the old version is
  offered again at the new one. The file's trigger id is always `file`. Instants are canonical,
  so re-spelling `starts` changes nothing.
- The commit never inserts a wake. The tick starts a dynamic routine's next run
  (`qorpera_restore_dynamic_routine_runs`), so no admission fence is taken after the clock.

**Status:**
- The file's status is the saver's word when the save changes it, and when it restores the file.
- Otherwise a pause, expiry or suspension that the platform recorded stays until core C2's queue
  writes it into the file. The only exceptions: a save revives an expired routine (the sweep
  expires it again while it has ended), and a new version with a paying login ends a wait for
  one. A platform commit's pause keeps the recorded reason.

**Database rules (contract 16.3):**
- While a run owes its routine's end-of-run decision, a unit from that run on that routine's
  file may only be the decision. The decision either sets a new `at`, optionally with a new
  title, instructions, effort or reply, or concludes with a `conclusion`. The run cannot pause,
  remove, move or otherwise change its own routine.
- A member's commit cannot create a `when: once` routine, or change a routine to it: "a
  member's save … cannot create a dynamic routine". Nor does a routine a member made become
  dynamic (the tick runs only an agent's dynamic routines).
- The platform starts no routine: nothing would pay for it.
- The id never changes and belongs to one file; the name is one no routine row of the agent from
  before the files has.
- The platform writes `status: paused` for:
  - an agent's archiving (the follow-up queue, so a restore does not revive the routine);
  - the authorization-failure suspension;
  - a member's Stop of a dynamic routine's run;
  - a routine left without a model account.

  Each platform commit records its reason. The index keeps it as `pause_reason`. Until C2's
  queue exists, the runtime writes these pauses to the index only.

**Review:** an agent creating, changing, moving or deleting a routine is delegation. The one
exception is the routine run's own end-of-run decision, when the actor's wake is this routine's
occurrence and only `at`, `effort`, `reply`, or `status: concluded` with `conclusion` change. A
decision that also changes the title or the instructions is reviewed as delegation (contract
16.3; `cloud-action-review.ts`).

**Index:** a new routine inserts `qorpera_cloud_routines` (`client_routine_id` is the file's id)
and its first version; deleting the file retires it (its runs and history stay) and gives its
key a tombstone, as a todo's; a restore brings it back; a move repoints it, and a move to
another agent's folder is a version like the last one with the new agent. The routine row is
locked at rank 5 `FOR NO KEY UPDATE` (a run of that routine holds it `FOR KEY SHARE`), with the
company row at rank 2 for the rows' foreign keys. The scheduler takes the company row `FOR
UPDATE` (its fence) before the routine, so it and a save wait for each other at the company row
(test 709). The member RPC (`qorpera_upsert_cloud_routine`) refuses a `folder-v2` company's
routines with 55000, except rows from before it became `folder-v2`. F1's C1b-3a (#497,
20260929230000) moves the company row to rank 0; F2-6 lands after it and takes the row there too
(its migration stops if it would put it back at rank 2).

### `agents/<handle>/todos/<name>.md`

| Key | Required | Values |
| --- | --- | --- |
| `id` | yes | UUID; workers reference it |
| `title` | yes | 1–200 bytes |
| `status` | yes | `open`, `blocked`, `done`, `cancelled` |
| `requested_by` | no | member id; without it the todo is the agent's own |
| body | no | what to do and what done looks like, up to 4000 bytes trimmed |

**Database rules (today's):**
- `done` is refused while a worker is active.
- A closed todo is not opened again; write a new file instead.
- `cancelled` stops the todo's active workers (follow-up queue).
- Moving or deleting a todo with an active worker is refused, and so is moving or deleting a
  folder that carries one (an agent's rename or retirement included).
- `requested_by` is checked (a member) only when the save changes it.

**Also:** the todo belongs to the agent whose folder holds it (its indexed `agent.md`, or the
`agent.md` the same unit writes, as a hire with its first todo); a move lands only in an agent's
`todos/`. The id never changes and belongs to one file; a file saved before this slice is the
saved version only once the index points at its path, and a restore is compared with the todo's
last file. The key is the file name.

**Index:** a folder row has no run ids (the commit records the actor) and may have no requester.
Deleting the file cancels an open or blocked todo, retires the row and gives its key a tombstone
with a `.` (no file name has one) and the whole id, so a new file of that name is free and two
tombstones never meet; a restore brings it back.
A todo save takes the company row at rank 2 (the row's foreign key).

Not reviewed. Dispatching a worker is reviewed.

### Worker brief and results

`agents/<handle>/todos/<todo>/<worker>/brief.md`:

| Key | Values |
| --- | --- |
| `id` | the worker's id |
| `title` | 1–200 bytes |
| `species` | `in-house` or `coding` |
| `access` | `read` or `write` |
| `revival` | `each` or `batch` |
| `dispatched_at` | UTC instant |
| body | goal, what done is, context, sources, output, cancellation and completion; follow-ups are appended |

`…/results.md`:
- settings: `outcome` (succeeded, blocked, failed, cancelled), `reported_at`, `decision`
  (accepted, rejected) and `note` (only with a decision, up to 1000 bytes);
- body: summary, what it needs, the files it made.

Only the platform writes these two files:
- the brief at dispatch and at each follow-up;
- the results at report and at the decision.

This holds for every worker species (contract 13). The worker's folder also holds the files a
write-access worker makes (today `work/todos/<agent>/<todo>/<worker>/`).

## 3. Refused files

A unit whose structured file cannot be read, or breaks a rule, is `refused`. The live file
stays at its old version. The refused bytes stay on the commit's receipt by hash, like a
conflict copy.

Units are decided in order (C1a). A unit sees the index as the earlier clean units of the same
change set left it, and so does its review class. The dependency rule:

- A routine, todo or worker file under `agents/<h>/` needs a live agent index row for `<h>` as
  of that unit: one that is not retired, whether active or archived. Otherwise it is refused
  (`no_agent`).
- So a hire and its first todo travel in one `new_folder` unit. They land, park for review, are
  denied or are refused together.
- A separate todo unit after a hire that parked, was denied or conflicted is refused, not
  orphaned.

A move or copy never changes a file's kind. It is refused (`kind_change`) if any file it
carries would become a structured file of another kind, or turn from structured to ordinary
or back. Examples: an ordinary `notes/hire.md` moved to `agents/nora/agent.md`, a todo moved
into `routines/`, a todo moved out to `notes/`. Write the new file instead.

A copy never lands a structured file (`structured_copy`), which narrows core §5's copy rule
("parse as a new file").
A copy would repeat an id, and a worker's brief and results are platform-only. So only moves
that keep every kind carry structured files. Their index rows are repointed without a new
parse, and the path checks above run on their new paths.

Outcome shape (core §3 "Outcomes"):

```json
{ "unit": 2, "op": "write", "path": "agents/nora-dahl/agent.md", "outcome": "refused",
  "reason": "structured_invalid",
  "problems": [ { "line": 6, "key": "status", "code": "value",
                  "message": "status must be one of: active, archived (found \"on leave\")" } ] }
```

**Reasons:**
- `structured_invalid`: the shared parser's problems. Their codes are `too_large`,
  `encoding`, `front_matter`, `syntax`, `unknown_key`, `duplicate_key`, `missing`, `value`,
  `quote`, `name` and `body`.
  - A refused file travels as `structured: {kind, problems}` without its text, so the unit
    always serializes (no NUL or lone surrogate in jsonb) and the commit records the refusal
    the same way for every writer.
  - A writer that cannot decode the bytes as strict UTF-8 reports `encoding` itself.
- `structured_rule`: a database rule, such as an id that another folder holds, the Co-Founder
  rules, an unknown time zone, a platform-only field, or `no_agent`.
- The 5.6 refusals keep their own reasons: `seeded`, `cofounder`, `lone_structured_file`,
  `kind_change` (which also covers moving an agent's folder out of `agents/` or into
  `agents/groups/`), `structured_copy`, and later `connected`. A coding session's write under
  `agents/` or `rules/`, and anyone but an owner or admin writing `rules/`, are `denied` by the
  core's authority (C1b-1).
- The trust boundary: the parse comes from the shared parser in trusted writers. SQL re-hashes the
  text, re-checks the parse's shape and limits for the kinds it indexes, and applies the database
  rules; it does not re-derive the parse from the text. The drift check re-parses stored bytes.

Messages name the fix: an unknown key lists the allowed ones, and a bad folder name suggests
one. Agents see them in the tool result or the shell report (F3), members in the editor, and
everyone on the commit in the history view.

## 4. Indexes

Each kind has one index, written in the commit's step 8 and pointing at the exact path version
it came from. An index never decides anything the file does not say. It may hold a trimmed copy
of the body, for readers that should not reach the storage server.

| Kind | Index | Keeps | Stays runtime state |
| --- | --- | --- | --- |
| vision | new `qorpera_folder_company_index` row | name, vision version, `vision_seeded`; `qorpera_profiles.name` is copied by the follow-up queue | — |
| agent | `qorpera_profile_staff` (folder columns `folder_environment_id`, `folder_path`: the stored path of its `agent.md`, `folder_path_version`, `folder_commit_id`, `folder_retired_at`) | name, role, instructions (charter), colour (`native` when none), figure, status; the Co-Founder's `template_id = 'co-founder'` and its `qorpera_company_cofounders` row (no formation) | lifecycle (setup), execution authority. `hire_overlay`, `reasoning_policy` and `startup_instructions` stay null on folder-v2 rows (the source-complete check ties them to the snapshot-v1 source columns), so the file's `model` and `effort` stay in the parse until the runtime reads them (F2-1b) |
| sections | sidebar sections and placements (+ #370's room placements) | section order, members in order | member pins and hidden |
| group | `qorpera_company_rooms` (folder columns as the roster's, with no bound agent), room members | name, subtitle, purpose copy, members, open or closed | conversation, drafts, mentions, session model |
| connection | new `qorpera_folder_connection_index`, one row per account keyed by the vault row's id (its own table, so a connection save never writes or locks a vault row) | path, path version, purpose copy | the vault row, secret versions, grants, audit |
| rule | `qorpera_review_rules` (company scope, folder columns as the roster's, `created_via` `folder`) | outcome, `when_text` copy | personal rules, review records |
| routine | `qorpera_cloud_routines`, `_versions` | owner from the folder, title, trigger, timezone, ends, runs, quiet with its zone, effort, reply, status, conclusion, intent copy | schedule cursors, occurrences, retries, sponsor, `pause_reason`, `authorization_failures`, `origin` (who created it, from the first commit) |
| todo | `qorpera_runtime_agent_todos` (folder columns as the roster's; run ids and requester optional for folder rows) | owner from the folder, key from the name, title, status, requester, detail copy | revision, publication columns (moot for folder rows) |
| worker-brief/results | `qorpera_runtime_workers` | dispatch and result copies | handles, leases, revival, completion |

- **Moves** repoint index rows without re-parsing. An agent rename carries its routines and
  todos along (core §5).
- **Deletes** mark rows retired at the last version. Runs and conversations that reference them
  keep working. **Restores** re-parse and bring them back. An agent's row is retired with
  `folder_retired_at` and `archived`, never `deleted_at`: `qorpera_protect_deleted_staff` freezes a
  row with `deleted_at` for good, which would make a restore impossible.
- **The roster's triggers** stay as they are and run for folder-v2 rows too: the agent's thread,
  the default grants, office access, execution access, connector grants, secret revocation on
  archive. The index writer sets only the columns that change, in one statement, so a trigger that
  runs on a column fires for real changes only, and every change bumps `version`, which pins a
  running agent's instructions (`qorpera_record_staff_operation`). A new id that another change set
  took first aborts this change set (23505); its retry is refused by `decide`.
- **Lock order with the triggers:**
  - Every roster write ends in a company operation (`qorpera_record_staff_operation`). That takes the
    company's operation clock and then the company row (`qorpera_profiles`) `FOR KEY SHARE`.
  - When a save renames, archives or retires an agent, the thread trigger also takes the agent's room
    `FOR UPDATE` and updates the thread's session, which is another company operation.
  - A run of the room takes the room `FOR KEY SHARE` at rank 4, before its paths.
  - Posting takes the company row `FOR UPDATE` (`qorpera_lock_profile_gc_fence`) before the room and
    the clock.
  - So `targets` returns the company row at rank 2 (`keyshare`, first within the rank) with every
    roster row, and the room at rank 4 (`update`) for a rename, archive or retire, all before the
    paths. Test 701 races a rename and an instructions edit against posting.
  - A `group.md` write takes the company row the same way: a new chat's room and conversation,
    and a conversation's title or status, are company operations too. A `sections.md` write takes
    it too: its rows reference the company row by foreign key, and one order keeps it simple. An existing
    chat's room is taken at rank 4 `FOR NO KEY UPDATE`: posting's `FOR SHARE` waits for it, a run's
    `FOR KEY SHARE` does not. Deleting or moving a folder takes the rooms of the chats in it. Test
    703 races a chat rename against posting.
  - Known, not F2's: the email-draft finish (agent threads only) locks the thread's session and
    then the gc fence, the other way round from posting, so it can lose a deadlock to an agent
    rename (found in F2-1's review). Its owner should take the gc fence first. It never reaches a
    group chat: claiming a draft is refused outside agent threads.
  - A `group.md` or `sections.md` parse stored under F2-1 alone was only kind-checked. A malformed
    one is not trusted as a base; a well-formed one is. F2-1 and F2-2 ship in one release, so no
    folder-v2 company (only an operator makes one before C5) saves such a file in between.
  - The sidebar tables take no lock of their own: `agents/sections.md`'s path lock orders their only
    writer. The member RPC's section and move actions refuse for `folder-v2` companies (55000), and
    the sidebar's revision row is not bumped; the web reads the folder feed (C4).
- `targets` reads the roster with no lock. A legacy roster write (`qorpera_put_profile_staff`)
  between `targets` and the rank-2 lock can still make the trigger take the room after the paths.
  That save can then deadlock with a run of that room (40P01; one side retries, no data is wrong).
  This ends when C1c stops legacy writes to folder-v2 rows (§9).
- The member RPCs of #462 (remove, change role, leave) take the company row before the member's row,
  while a save takes its member row at rank 1 and the company row at rank 2. So a membership change
  of the saving member can deadlock with that member's roster save (40P01; the save retries). This
  ends when F1 takes the company row before the members (a rank 0), which fits posting and #462.
- A row removed outside its folder (`deleted_at`, the legacy roster delete): `decide` refuses an
  edit of its `agent.md`; moving or deleting its folder is saved and leaves the row alone.
- **Rebuild:** a job lists every structured path, reads the bytes and parses them with the
  shared parser. It then calls `qorpera_folder_index_rebuild(env, kind, rows)`, which fixes rows
  under the same locks as a commit. In dry-run mode it is the daily drift check, reported to
  operators only. Each stored parse records `COMPANY_STATE_PARSER_VERSION`, so drift from a rule
  change is told apart from drift in the data.
- **Follow-ups** (core §5 "After the commit"), which need C2's queue:
  - a hire's first run (its thread, grants and execution access come from the roster's
    triggers today);
  - an archive's paused routines and removed execution access (no trigger does these);
  - a cancelled todo's workers;
  - the company name copy to `qorpera_profiles.name`.

  Consumers that must react at once read the index directly: wake admission, routine firing,
  the secret broker, coding admission, screens and run authority.

## 5. What the runtime reads

| Context | Today | `folder-v2` |
| --- | --- | --- |
| company name | `qorpera_profiles.name` | the vision index |
| vision | not composed | `vision/vision.md` in full, every run, version recorded |
| agent identity and instructions | staff row, charter | the agent index (settings, instructions copy) pinned to the path version, plus its folder path |
| first task | kickoff session input | the first todo file (pending decision 2) |
| coworkers | staff rows | the agent index, with handles |
| group chats | rooms | the group index |
| routine intent | routine version prompt, on its wake | the routine index's intent copy of the woken version |
| open work | todo and worker counts | the same, from the todo index |
| memory, skills | `agents/<id>/…` | `agents/<handle>/…`, through one agent-folder helper (agreed with the coordinator and the #387/#400 session) |
| rules (reviewer) | rule rows | the rule index, with the versions read; personal rules unchanged |
| connections | vault rows and grants | the same, plus the purpose copy |

Until the mount's writes are accepted (F3), these tools become thin writers of these files:
`hire_agent`, `create_group_chat`, `organize_sidebar`, `manage_todo`, `manage_routine` and
`decide_routine`. They use the canonical writers here, or `setCompanyStateSettings` for a
one-key change. After that, all but `decide_routine` retire. `decide_routine` stays, because
the kernel enforces the routine run's decision.

## 6. What the web app reads

| Screen | Reads | A save writes |
| --- | --- | --- |
| sidebar | agent, sections and group indexes; own pins and hidden | `agents/sections.md` |
| agent details | agent index; `agent.md` for the instructions | `agent.md` (`setCompanyStateSettings` for one setting, `writeAgentFile` for new) |
| new agent | — | one `new_folder` unit: `agent.md`, the first todo |
| group chat details | group index | `group.md` |
| routines | routine index, runs from occurrences | the routine file |
| Settings → General → Rules | rule index, own rules | `rules/<name>.md`; own rules as today |
| Settings → Connections | vault rows, file body | vault actions write the file; the purpose edits the body |
| company name | vision index | the first line of `vision.md` |
| Company File page (#386) | the folder | any file; a refused save shows its problems |

The index tables keep their Realtime hints. The file page follows the folder feed (core §6,
C4). After a save, the app waits for the index row to reach the path version it wrote, instead
of today's `revision`.

## 7. The hook interface with the storage core

Agreed with F1 on #408: F2 proposed in comments 5864281465 and 5865135113, and F1 answered in
5864414721 and 5865197696. C1b adds the call
sites to `qorpera_folder_commit` with inert stubs of exactly these signatures, and F2's SQL
slices replace the stub bodies with `create or replace`, never touching the commit. F1 owns the
commit, its lock order, and the follow-up queue table and its drain loop. F2 owns the functions it calls. F2-1 also
teaches F1's `qorpera_folder_structured_lock` one more table, the company row (§4). All are plpgsql with
`search_path = ''`, security definer except `targets` (it runs inside the commit, with its rights), and called only
from the commit or the rebuild. They
raise only for malformed calls. `decide` checks every index constraint, so `apply` never raises
on a unit that `decide` passed.

| Core §3 step | Function | Does |
| --- | --- | --- |
| before tx (TS) | `parseCompanyStateFile(path, text)` | Each structured path of a unit gets an entry in `structured: [{path, kind, text, parse, parserVersion}]`, or `[{path, kind, problems}]` without the text when refused. A `new_folder` lists every structured file inside it. SQL re-hashes each parsed file's text against its file hash. |
| any | `qorpera_structured_path_kind(path)` | The pattern table, on the key. |
| 4, plan | `qorpera_folder_structured_targets(p_environment_id uuid, p_actor jsonb, p_units jsonb) returns table(rank smallint, tbl text, key text, mode text)` | Takes no locks. Returns the rows to lock, each with its rank and mode: index rows by parse id, index rows by path prefix for a subtree unit as of its `asOfSeq`, referenced member rows that an index row depends on (rank 1, KEY SHARE; none so far: `people` and `connected_by` are read without a lock, since no index row depends on them), and unique claims (`key` is a uuid as text, or a claim key). Rows of F1's tables (members, execution authorities, resources, grants) are merged into F1's own pass at their rank, the stronger mode winning. |
| 4, lock | `qorpera_folder_structured_lock(p_environment_id uuid, p_targets jsonb, p_from_rank smallint, p_to_rank smallint) returns void` | Locks F2's tables through a closed list, in key order. F1 calls it for ranks 2, 4–5 and 8–9, between its own ranks 1, 3, 6 and 7. |
| 7, per unit | `qorpera_folder_structured_decide(p_environment_id uuid, p_actor jsonb, p_commit_id uuid, p_unit_no integer, p_unit jsonb, p_eff_path text, p_eff_to text) returns jsonb` | Runs after F1's own checks, on the effective (stored) paths. Covers the path checks, the database rules, the dependency rule and the 5.6 refusals, and returns `{ok, reason, problems}`. It reads the index as the earlier units of the commit left it. |
| 7, review | `qorpera_folder_structured_review_class(p_environment_id uuid, p_actor jsonb, p_unit jsonb, p_eff_path text, p_eff_to text) returns text` | Returns plain, delegation or deletion, from the base parse (the current entry's path version) and the new one. The TS proposal before the transaction applies the units in the same order, so both sides agree. |
| 8, per clean unit | `qorpera_folder_structured_apply(p_environment_id uuid, p_commit_id uuid, p_unit_no integer, p_unit jsonb, p_eff_path text, p_eff_to text) returns void` | Writes the index rows, the parse and the follow-up rows. It finds each file's new version in `qorpera_folder_path_versions` by (commit, unit, key). |
| 9 | `qorpera_folder_structured_verify(p_environment_id uuid, p_commit_id uuid) returns void` | Checks that each index row written points at its entry's current version; raises XX000 on a mismatch. |
| after | `qorpera_folder_converge_<kind>(env, subject)` | The follow-ups, safe to repeat. |
| any | `qorpera_folder_index_rebuild(env, kind, rows)` | Rebuild and drift check. |

**Settled:** a rename writes `agent.md`, then moves the folder, in one change set.
- C1a's unseen-change check is `c.seq > v_as_of`, and the running commit's `seq` stays NULL
  until the clock step, so a unit's own earlier writes never count. Writing a child does not
  change the folder's version, so the move's `expectedVersion` holds.
- The reverse order (move, then write with the old version) conflicts.
- F1 kept this on purpose and covers it with test 630 (`r2-edit-then-rename`).

**Lock ranks** are core §3 step 4 as written: 1 members (commit), 2 staff (F2), 3 execution
authorities (commit), 4 rooms then room members (F2), 5 the other index rows by table then id
(F2), 6 resources ancestors first (commit), 7 grants (commit), 8 vault rows (F2), 9 unique-key
claims by kind then key (F2). All nine come before paths, objects, admission and the clock.

**Agreed with F1:**
- The parse is stored as a nullable `structured jsonb` on `qorpera_folder_path_versions`, added
  by F2's first SQL slice and set only for structured kinds.
- The company name index is `qorpera_folder_company_index`; the follow-up queue copies the name
  to `qorpera_profiles.name` for old readers, and commits never lock the profile row.
- C1b brings `staff_agent` actors with the run and its lease, the fence revision, the causal
  wake (routine id and version for a routine run) and the session kind (`in_house`, `coding`).
- New-folder content paths are spelled with `qorpera_folder_spelled_contents(root, contents)`.

## 8. Build order

1. **F2-0** (this): this document and the shared parser, with tests. No SQL; inert.
2. **F2-1** vision and agents, in the database (migration 20260928249020):
   - the pattern table, the path checks, the stored parse, the company index, and the staff
     index for `folder-v2`;
   - the seeded-path, Co-Founder, lone-file, kind-change and copy refusals, and the review
     class;
   - hire, edit, archive, rename, delete and restore;
   - the seed tree for C2's creation commit (`companyStateSeedTree`, §9).

   **F2-1b** follows: the follow-ups on C2's queue, the context composer reading the vision and
   `agent.md`, and the agent-folder helper for memory and skills.
3. **F2-2** group chats and sections (migration 20260928249100; for new companies it replaces
   #370's writes and `organize_sidebar`):
   - the rooms table's folder columns, and the parse shape and database rules of both kinds;
   - `group.md` to rooms, room members and the conversation; `sections.md` to the sidebar's
     sections and placements;
   - the member RPC's section actions refused for `folder-v2`.
4. **F2-3** connections (migration 20260928249140): the parse's shape, the rules and the index
   table. The vault's writer is core C3's; the vault's SQL cannot create file bytes, so it stages
   the text through the object gateway first, or C2's queue writes the file after the vault
   commits.
5. **F2-4** rules (migration 20260928249190): the reviewer reads the rule index, its own table;
   the Settings RPCs refuse company rules for folder-v2.
6. **F2-5** todos and worker files: **F2-5a** todos (migration 20260929210000); **F2-5b** worker
   briefs and results, with core C3's writers, which dispatch and report through the platform.
7. **F2-6** routines (migration 20260929310000), last because the scheduler, schedule positions
   and decisions are the most delicate part. `file-change` routines wait for core C4.

Each step comes after F1's C1 (C1b brings the call sites), is `folder-v2` only, rides the release
train, and gets an independent exact-head review. The web screens for each kind follow with
core step C4.

## 9. The seeded tree

`companyStateSeedTree({companyName, cofounderId, vision?, founders?, firstTodo?})` lists what a new
company's folder holds, parents first, and C2's creation commit writes it in one change set as the
platform:

- `vision/` and `vision/vision.md`: the name, the founders' text from the founding table, then the
  four seeded headings, with a `- name: role` line per founder under "How we work";
- `agents/` and `agents/sections.md` (no sections);
- `agents/co-founder/` with `agent.md` (`kind: co-founder`, `status: active`, colour blue,
  figure crown, and `COMPANY_STATE_COFOUNDER_INSTRUCTIONS`, whose first job is the vision), and
  its empty `memory/`, `skills/`, `routines/` and `todos/`;
- with `firstTodo`, the Co-Founder's first todo at `COMPANY_STATE_FIRST_TODO_PATH` ("Start with the
  founders", requested by the founder who started the table);
- `agents/groups/`, `connections/`, `skills/` and `rules/`.

It throws a `RangeError` when a file would not parse (a founders' vision past the size limit), so
C2 never sends a creation commit the database refuses.

The creation commit's `agent.md` with `kind: co-founder` also records the Co-Founder
(`qorpera_company_cofounders`), since no Co-Founder is recorded yet, the actor is the platform, and
the agent is new: an agent already on the roster never becomes the Co-Founder. After that, only
that id has the kind, and one change set may carry only one. For folder-v2
companies the creation path must not also run the old chain (`qorpera_seed_company_cofounder`, the
snapshot bootstrap). If it runs first, its database-only Co-Founder makes the creation commit's
Co-Founder unit refused; if it runs after, it finds the recorded one. Either way the old chain
queues its own first run and leaves the company half on the old core (C2; #444 comment 5872662909).

Found while building F2-1, for F1 (C1c): `qorpera_put_profile_staff` and
`qorpera_delete_profile_staff` still write folder-v2 roster rows directly, since their guards look
at snapshot-v1 columns, and `qorpera_ensure_default_agent_read_grants` (the roster's default-grant
trigger) inserts grants outside the authority journal and the rank-6 lock of C1b-2. A folder-v2
index row should change only through its file.

