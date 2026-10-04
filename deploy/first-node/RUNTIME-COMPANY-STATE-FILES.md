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
| `human-tasks/<name>.md` | human-task | yes (H1; indexed and ruled by H2) |
| `contacts/<name>.md` | contact | yes (H1; indexed and ruled by H2) |

A path's kind is decided on the folder's key (`companyPathKey`, the same NFKC-casefold as
`qorpera_company_path_key`, 20260828005000), because two spellings with one key are one entry:
`ＡＧＥＮＴＳ/anna/agent.md` is Anna's `agent.md`. The database classifies on `key_text` and
refuses a unit on a structured key that carries no parse. JavaScript and Postgres may case-map a
few characters differently (`İ`); such a path then fails closed in the database, and the
comparison test below includes these spellings. Every other file is ordinary: one
pattern match and nothing else. Files nested deeper (a note in `routines/notes/`, a worker's
output next to its brief) are ordinary. Core §5's list gains `vision/vision.md`, the two
worker files, and (H1) `human-tasks/<name>.md` and `contacts/<name>.md`.

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
folders, routine, todo, rule, connection, human-task and contact files, todo and worker folders,
the top folders `human-tasks` and `contacts`, and a human task's folder and its `proof/` folder.

These path checks are `companyStatePathProblems(path, folder)`. They need no text, so the
database runs the same list, and the comparison test covers both. `decide` runs them on the
path an entry is actually stored under, its parent folder's stored spelling included:
- for every file a unit writes;
- for every structured file a move or rename carries, at its new path;
- for every folder a unit creates or renames at a structured place: `agents/<h>`,
  `agents/groups/<g>`, `agents/<h>/routines`, `agents/<h>/todos`, `agents/<h>/todos/<t>`,
  `agents/<h>/todos/<t>/<w>`, `human-tasks`, `contacts`, `human-tasks/<t>` and
  `human-tasks/<t>/proof`. The two top folders carry no name of their own; they are places only so
  that a wrong spelling such as `Contacts/` cannot be made and block every later save.

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
| `status` | yes | `connected` or `broken`; a website account also `pending` (opened, not yet verified) or `needs_person` (waiting for a step only a person can do) |
| `actions` | yes | the catalog's operation ids every agent may use (may be empty) |
| `connected_by` | yes | member id, or for a website account the agent that opened it |
| `connected_at` | yes | UTC instant |
| `site` | with `service: website`, and only then | the website's host as the vault keeps it: lowercase labels of 1–63 letters, digits and inner hyphens, at least two, up to 253 characters (`qorpera_company_account_host_valid`); a host YAML would read as a number is written in quotes |
| `two_step` | with `service: website`, and only then | `none`, `authenticator`, `email` or `sms` |
| `opened_for` | no; `service: website` only | the id of the todo an agent opened the account for; absent when a member handed the account over |
| body | no | what the account is for, written by the company |

- **Website accounts (A1):** an account the company owns at a website (`service: website`), kept in
  the vault (`qorpera_company_accounts`). `site` is shown and never used: where a secret may be
  typed stays in the vault, so editing the file can never move a password. The parse has `site`,
  `twoStep` and `openedFor` (`null` when absent) only for a website account; any other
  connection's parse keeps its shape. Closing an account revokes its vault row at once (A1, 2
  October; #668), so its file is removed at close, as any disconnected connection's: no file ever
  says closed.

- **Settings:** written only by the platform (the vault's writer, core C3). A member or an agent
  may change the body only, and never creates or deletes the file.
- **Body:** company-authored.
- **Authority:** the vault and the operation grants stay in charge (contract 5.6). Every tool that acts on an account
  (open, fill, find, use, Disconnect) reads the vault, never this file: the file describes the account and may trail
  the vault by seconds.
- **How it is written (P22, 3 October 2026):** only the catalog's connectors (Gmail, Drive, GitHub …) and website
  accounts have a file; a hook's signing secret and a secret card do not (the event intake describes hooks itself). A
  vault change on such a company-owned connection of a folder-v2 environment inserts a due mark in its own transaction (`qorpera_folder_connection_file_marks`, migration `20260930006000`): a
  secret written or revoked, its account name changed, an operation grant on it given or withdrawn, a website
  account's status, login, site, two-step method or todo changed. The object gateway's writer claims a due connection
  (`qorpera_claim_connection_file`), gets what the file should say, built from an allow-list of the vault's fields only
  (never a secret, an envelope, a key or the vault's own purpose text), commits one unit as the platform with the
  operation key `connection-file:<secret>:<generation>` and the version it read (keeping the company's text below the
  settings; a member's edit meanwhile makes it read again), and finishes the claim
  (`qorpera_finish_connection_file`); a claim never waits for a vault change or a company being deleted (only,
  briefly, for another claim's new work rows), and a writer makes one per transaction. A claim skips a company whose
  creation has not completed (P14a, migration `20260930010000`); its marks wait until it has. A revoked secret or
  a closed account means its file is deleted. `actions` lists the operations with an active, unexpired grant; an expiry
  marks nothing, so the file shows an expired grant until the connection's next change.
  `qorpera_mark_connection_files(environment)` marks every connection due at once: an operator step, in its own
  transaction, for a company whose vault held connections before it became folder-v2 or a connector that gained
  catalog operations later. A new file is
  named after the site, or the connector (and the vault's name unless it is `primary`), in the name rule (cut to 64
  characters); when the name is taken the writer numbers it `-2`, `-3` …, cutting the name so the number fits.
- **Database rules:** the id is a company-owned vault row (`qorpera_cloud_secrets`) of this
  company and environment, and never changes. A platform write matches that row: it is active and
  its connector is the `service`. One file holds one account. A file saved before this slice is not
  trusted as the saved version until the platform writes it (the index points at its path).
- **Deleting:** only the platform deletes the file, and only once the vault record is revoked
  (refused while it is active, whatever its status). Disconnecting removes the file; a file a member moved
  meanwhile is found again through the index on the next claim.
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
  rule save takes the company row at rank 0 first.
- Never reviewed.

### `agents/<handle>/routines/<name>.md`

**Pending decision 3:** exactly one trigger per file. F2-6 (migration 20260928259310) is built on
it; a different answer changes the parser and `qorpera_company_state_routine_trigger` only.

| Key | Required | Values |
| --- | --- | --- |
| `id` | yes | UUID: the routine id cursors and occurrences use |
| `title` | yes | 1–160 bytes |
| `status` | yes | `active`, `paused`, `concluded` ("expired" is derived by the scheduler) |
| `when` | yes | `every`, `weekly`, `window`, `once`, `file-change` (on `folder-v2` since core C4's P29, below); `event` comes with W2 (#519): `hook` (the hook's lowercase uuid), optional `only` (1–20 distinct event types), plus `timezone` and `reply`, added by whichever of W2 and F2-6 lands second |
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

**`file-change`** (core C4, P29; `RUNTIME-COMPANY-FOLDER-LISTENER.md`): the agent is woken once for each saved change
set that touches `watch` (the path itself for `exact`, the path or anything under it for `subtree`), with the changed
paths it may read. Its own change sets never wake it.
- The save refuses a `watch` the agent, with its requester, may not read, and a routine a ChatGPT plan would pay for.
- The routine listens from the change set that last saved its file. **Any save of the file, even one that changes
  nothing, drops the changes the listener had not reached yet:** they are never delivered. A resume is a save, so it
  starts again from the resume.
- While the company is paused, changes wake nothing and are not replayed after the resume.
- A path the agent may not read is never named or counted. The wake names at most 21 changes and counts the rest.

**Ownership:**
- A key of another `when` is refused by name.
- The owner is the agent whose folder holds the file. Moving the file to another agent's
  `routines/` hands the routine over.
- Who pays for a routine's runs is not in the file (the "starter pays" work, S2: a member's login
  pays only for work that member started). The saver's own login that pays for unattended work
  (a member's, or a run's requester's; the rule of `qorpera_agent_routine_sponsor`, read without
  its lock on the login) pays for a new version and for work a save starts or extends: a resume,
  a reopen, reviving an expired routine, more runs, a later end, a handover to another agent. A
  version on another login moves to the saver's. A pause, a conclusion, fewer runs, an earlier
  end or new quiet hours need no login.
- A member without such a login cannot make those saves, and neither can an agent acting with no
  run (a coding session, or a desktop whose run ended: C1b-3a's views) for a member without one. A
  run whose requester has none pins the run's login, and the routine waits (`needs_model_account`). Unlike an agent's save today, the
  commit never sets up a login for unattended work (that takes the login `FOR UPDATE` and writes
  rows after the clock): the runtime's routine writer does it before its commit (F2-1b).
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
  expires it again while it has ended), and a new version with a paying login (a save's, or a
  handover's) ends a wait for one. A platform commit's pause keeps the recorded reason.
- A routine whose runs are used up has ended (`expired`), as the recorded occurrence at its limit
  leaves it; more runs start it again.

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
exception is the routine run's own end-of-run decision while it is owed, when the actor's wake is
this routine's occurrence and only `at`, `effort`, `reply`, or `status: concluded` with
`conclusion` change. After the run decided, or another change settled the decision, its changes
are delegation. A run that concludes its routine (reviewed, for a fixed routine) keeps working to
its end. A
decision that also changes the title or the instructions is reviewed as delegation (contract
16.3; `cloud-action-review.ts`).

**Index:** a new routine inserts `qorpera_cloud_routines` (`client_routine_id` is the file's id)
and its first version; deleting the file retires it (its runs and history stay) and gives its
key a tombstone, as a todo's; a restore brings it back; a move repoints it, and a move to
another agent's folder is a version like the last one with the new agent, paid by the mover. The routine row is
locked at rank 5 `FOR NO KEY UPDATE` (a run of that routine holds it `FOR KEY SHARE`), with the
company row at rank 0 for the rows' foreign keys. The scheduler takes the company row `FOR
UPDATE` (its fence) before the routine, so it and a save wait for each other at the company row
(test 709). The member RPC (`qorpera_upsert_cloud_routine`) refuses a `folder-v2` company's
routines with 55000, except rows from before it became `folder-v2`; the agent tools
(`qorpera_manage_agent_routine`, `qorpera_decide_agent_routine`) refuse on a `folder-v2` company, whose
agents write routine files (their file writers come with F2-1b). The name index
(`qorpera_cloud_routines_agent_key`) covers file routines of either origin. Known: a save that
carries several routines (an agent folder's delete or move) locks them in id order while the
expiry sweep updates ended routines in its own order, so the two can deadlock (40P01; one side
retries, nothing is wrong). F1's C1b-3a (#497,
20260928259230) moved the company row to rank 0, before the members; F2-6 takes it there too (its
migration stops if that change has not run).

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
A todo save takes the company row at rank 0 (the row's foreign key).

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
| `follow_ups` | the number of follow-ups, 0 at dispatch (F2-5b) |
| `followed_up_at` | UTC instant of the latest follow-up, when `follow_ups` is 1 or more |
| body | the sections `## Goal`, `## Done when`, `## Context` (optional), `## Sources` (optional; `- <path>` items), `## Authority`, `## Output`, `## Cancellation`, `## Completion` and `## Follow-up` (the latest, after a follow-up), in that order (§8 "Plan (F2-5b)") |

`…/results.md`:
- settings: `outcome` (succeeded, blocked, failed, cancelled), `reported_at`, `decision`
  (accepted, rejected) and `note` (only with a decision, up to 1000 bytes);
- body: the summary, then `## Needs` exactly when blocked, then `## Files` (`- <path>` items, the
  files it made).

Only the worker tools write these two files, as the run that dispatches, follows up, reports or
decides; a restore of a deleted agent brings them back as they were (§8 "Plan (F2-5b)", contract
13):
- the brief at dispatch and at each follow-up;
- the results at report and at the decision.

This holds for every worker species (contract 13). The worker's folder also holds the files a
write-access worker makes (today `work/todos/<agent>/<todo>/<worker>/`).

### `human-tasks/<name>.md`

Work an agent hands to a person: a member, or a contact outside the company (Q1 §5, "Work for
people"). One file per task; the task's folder beside it holds what the person sends back. It is
the last step of the escalation order (16.1, as the 2026-10-02 amendment "work for people" widens it).

```
---
id: 5d0c2f7e-8b1a-4c55-9a43-0f6e2b7d91c4
title: Fit the second disk in node 2
status: open
member: 0b7d2e41-6c3a-4f18-9e25-8a1d4c6f2b90   # Jonas
from: 7f3a9c21-44d0-4e6b-8a55-2c1f0b9e3d77     # Operations
todo: 3c9e1a52-7d4b-4f60-8e21-5b0a9c7d2e14     # node-2-storage
due: 2026-10-09T16:00:00Z
minutes: 40
proof: [photo, note]
---
## Why
Node 2's storage is 91% full and fills up on 21 October at this rate.
## Steps
- [ ] Order a 4 TB NVMe, same model as slot 1
- [x] Agree a 30-minute window with the coordinator
- [ ] Fit it in slot 2 and power on
- [ ] Photograph the label, serial number readable
## Done looks like
The photo, and a note with the time node 2 was back up.
```

| Key | Required | Values |
| --- | --- | --- |
| `id` | yes | lowercase UUID; never changes |
| `title` | yes | one line, 1–200 bytes |
| `status` | yes | `open`, `done`, `accepted`, `returned`, `declined`, `cancelled` |
| `member` | exactly one of `member` and `contact` | the member it is for: a lowercase user id |
| `contact` | exactly one of `member` and `contact` | the contact it is for: a contact file's `id` |
| `from` | yes | the asking agent's id |
| `todo` | no | the `id` of the asking agent's todo that waits on it (a note may name it) |
| `due` | yes | UTC instant |
| `minutes` | no | the expected time, whole minutes 1–480 (shown as "About 40 minutes") |
| `proof` | no | what counts as done: one or more of `photo`, `file`, `signature`, `note`, no repeats |
| `files` | no | 1–20 company-folder paths of files the person needs (a draft to check); rules below |
| `reason` | with `returned` and `declined`; allowed with `cancelled`; refused otherwise | one line, 1–500 bytes: why it went back, why the person can't, or why it was cancelled |
| `secret` | no; with `member` only | one line, 1–100 bytes: the label of the one secret the person enters ("Code from the SMS") |
| `secret_state` | with `secret`, and only then | `asked` or `saved` |
| `connection` | no | the `id` of the `connections/` file the step is for (A1) |
| `step` | no | the kind of step a website demands of a person (A1): `sign_in`, `captcha`, `phone_code`, `id_check`, `payment`, `create_account`, `other` |
| body | yes | 1 byte to 32 KiB trimmed; the headings `## Why`, `## Steps`, `## Done looks like` are the convention, not required |

A list key is either left out or holds at least one item (`proof: []` is refused: leave it out).

- **Steps.** The steps are the lines of the first section whose heading line is exactly
  `## Steps` (after the closing `#`s and the spaces around the text are dropped, as `sections.md`
  reads headings). The section ends at the next line that starts with `# ` or `## `. A step is a
  line in that section that starts, at column 0, with `- [ ] ` (open) or `- [x] ` / `- [X] `
  (done); its text is the rest of the line, trimmed of U+0020 spaces. A carriage return before
  a line end is dropped first. Other lines in the section are text. Fenced code gets no special
  reading. The file is refused if a step's text is empty, longer than 500 bytes, or not one line
  (a C0 or C1 control character, a tab included, or U+2028/U+2029, as §1's one-line fields), or
  if there are more than 50 steps. The parse lists them as
  `steps: [{line, text, done}]` (`line`, the file's line number, lets H2 compare two versions line
  by line). A body without such a section has no steps. The whole body stays the task's
  `instructions`. In H2 a person's own change may flip a box and nothing else: no text changed,
  no line added or removed.
- **`files`.** Each entry is a literal path the company folder can hold, by the core's path rule
  (`parseCloudCompanyPath`, SQL's `qorpera_company_path_valid`: relative, NFC, at most 4096 bytes,
  no empty, `.` or `..` part, no trailing `/`, no `\`, `%` or `:`, no part ending in `.` or a
  space, no reserved device name), and one line; a pattern character such as `*` is part of a
  name, never a pattern. A plain entry that YAML reads as something other than text (`42`,
  `true`) is written in double quotes, as in `asks`. Repeats are compared by key
  (`companyPathKey`), since two spellings are one entry; the database compares by its own key.
  The two keys fold some characters differently (74 in the BMP today, among them `ß`, `İ` and
  U+A7F1; §1), so either side may refuse as repeats two entries the other keeps apart. On a contact's task an entry whose key is under `agents/`,
  `contacts/`, `human-tasks/`, `connections/`, `rules/` or `hooks/` is refused: the company's
  people, other tasks, accounts and rules are not for outside readers. `files` never grants anything (H3, H5):
  - a listed file opens only if the agent that sent the link may read it at that moment, by its
    standing read authority (not the ended run's), and on a member's own task page only if that
    member may read it;
  - a contact's link keeps the list its review approved, and an open shows only the paths on both
    that list and the current one: a removal works at once, an addition needs a new reviewed
    send. A path that no longer exists, or became a folder, is not shown;
  - the reviewed send also pins each listed file's version: an open shows that version, and only
    while the sender may still read the path. A newer version needs a new reviewed send, like an
    addition, so a contact never sees content nobody reviewed;
  - the address and the expiry are pinned the same way: a later change of the contact's `email`
    or the task's `due` never redirects or extends a link already sent;
  - a link goes out only through a reviewed send, never from a file save.
- **Secrets.** `secret` holds only a label. The value goes to the vault, bound to the task's
  `id` (as W1b binds a hook's signing secret to its hook), so a task file can never point at
  another secret, and the file has no secret name. Only the platform sets `secret_state: saved`;
  H1's database already refuses `saved` from anyone else unless the file the save replaces had
  `saved` with the same `id` and the same label.
- **No contact details.** A member is reached through their account and a contact at the address
  in their contact file. A link's token (kept only as a hash), an email's delivery and a
  secret's value are runtime state or vault records, never the file: every member and agent reads
  the folder.
- **The task's folder:** `human-tasks/<name>/proof/` holds the person's files (H2 names them as
  they arrive) and `human-tasks/<name>/note.md` the person's own note. Both are ordinary files.
  The folder's name is the task file's name.
- **What H1 does not decide (H2):** decided in §8 "Plan (H2)". Where the two differ, the plan wins: its
  §1 and §4 replace the person's change "by the platform", the folder carried along with its file, and
  "only the platform writes under `human-tasks/<name>/`" below.
  - who may set which status: the agent `open`, `accepted`, `returned` and `cancelled`; the
    person `done` and `declined`. A person's own change is a tick, or `done` or `declined` with
    its proof, note and `reason`, saved in one change set by the platform as the person's change,
    and not reviewed;
  - that `member`, `contact` and `connection` exist in this company, and `todo` is an open todo of
    the `from` agent, so a task never wakes another agent's todo; that `from` is the saving
    agent's own id and never changes; that `id` is unique among the tasks and never changes; a
    `member` change hands the task on;
  - that a contact's task shares company files outside the company. The link's send is the
    reviewed outside action, like `send_mail`, and nothing is sent by a file save; whether
    creating or changing a contact's task (or its `files`) is also reviewed needs a review class
    folder commits do not have today, and H2 decides it. A task for a contact with no `email` is
    refused when it is created (H2, H5);
  - the task's folder follows its file: the platform's writer carries the folder in the same change
    set when a member or an agent moves or deletes a task file (so a task with proof can still be
    renamed or removed), and a new task file is refused while a folder of its name exists; only
    the platform writes under `human-tasks/<name>/`, as the person's change; a contact's proof and
    note are outside content (11.1);
  - the overdue wake and the wake on `done` and `declined`; the index; seeding `human-tasks/` and
    `contacts/` in new companies (and whether they join the seeded folders that cannot be
    deleted or moved);
  - a file saved before H2 is trusted for its shape only: H2's first index of it checks every id
    and every value only the platform may set.

  A1's takeover tasks need H2, not only these keys. Until H2 a human-task file is a checked
  format and nothing more.

### `contacts/<name>.md`

Everyone outside the company it deals with, one file per person or firm: contractors, suppliers,
customers and leads. Agents keep the file current. A contact never has an account; it reaches a
task only through a task link (H5) sent to the address in this file.

```
---
id: 9a1f6c3e-2b7d-4e58-a0c4-7d3e1f9b6a25
name: Maria Jensen
organization: Jensen Revision ApS
email: maria@jensen-revision.example
asks: [bookkeeping review, VAT filing]
---
Our accountant since 2025. Files VAT every quarter.
## History
- 2026-10-08 Filed Q3 VAT (human-tasks/file-vat-q3/proof/receipt.pdf)
```

| Key | Required | Values |
| --- | --- | --- |
| `id` | yes | lowercase UUID; tasks name the contact by it; never changes |
| `name` | yes | one line, 1–200 bytes |
| `organization` | no | one line, 1–200 bytes |
| `email` | no | 3–254 bytes of printable ASCII (`!` to `~`, so no space), exactly one `@` with text on both sides, and a domain that neither starts nor ends with `.` |
| `phone` | no | `+` and 6–20 digits, with single U+0020 spaces allowed between digits |
| `asks` | no | what the contact may be asked to do: 1–50 one-line items of 1–100 bytes without spaces at either end, no exact repeats |
| body | no | up to 32 KiB trimmed: notes, then `## History` lines agents add after each task |

- **Personal data.** A contact who asks to be forgotten needs an erasure of any deleted path:
  core §8 today erases only a deleted agent's folder, and is not built yet (C2). That widening is
  F2's (the coordinator's plan of 2 October 2026), and lands before H5 sends any link. It covers
  the contact file, the folders of that contact's tasks, and path names in commit units, as core
  §8 does for agents. It cannot find
  free text elsewhere (task titles and bodies, `reason`, `## History` lines, agents' memory),
  which a member removes by hand. The writing skill tells agents to name a contact by id only.
- **What H1 does not decide (H2):** that `asks` covers a task's work is the agent's judgement (the
  seeded skill `skills/human-task/SKILL.md`), not a database rule; that `id` is unique among the
  contacts; the index; a task link (H5).

The parses, with absent values `null` and absent lists `[]`:
- human-task: `{kind, id, title, status, member, contact, from, todo, due, minutes, proof, files,
  reason, secret, secretState, connection, step, instructions, steps}`;
- contact: `{kind, id, name, organization, email, phone, asks, notes}`, with `notes` the trimmed
  body (`""` when there is none).

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
| human-task, contact | `qorpera_folder_human_task_index` and `qorpera_folder_contact_index` (H2), keyed by environment and id | path, path version, status and references of a task; whether a contact has an email | the wake markers (H2c) |

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
  - So `targets` returns the company row at rank 0 (`keyshare`; C1b-3a moved it from the head of rank 2) with every
    roster row, and the room at rank 4 (`update`) for a rename, archive or retire, all before the
    paths. Test 701 races a rename and an instructions edit against posting.
  - Since C1c-3c (migration 20260928399690, which patches `targets` in place): for an agent with no thread room yet
    (a new agent, or one saved archived and now activated), `targets` also returns every member row at rank 1
    (`keyshare`). The room it creates copies the roster without a lock, so a member's removal or demotion (the member
    row `FOR UPDATE`) must run before or after that copy. A later rewrite of `targets` must keep this branch (test 665
    F).
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
  between `targets` and the company-row lock can still make the trigger take the room after the paths.
  That save can then deadlock with a run of that room (40P01; one side retries, no data is wrong).
  This ends when C1c stops legacy writes to folder-v2 rows (§9).
- The member RPCs of #462 (remove, change role, leave) take the company row before the member's row.
  A save used to take its member row at rank 1 and the company row at rank 2, so a membership change
  of the saving member could deadlock with that member's roster save. Resolved in C1b-3a: the
  company row is rank 0, before the members, which fits posting and #462 (test 644 D).
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

**Built (F2-1b, migration 20260928269440):**
- Part A. `qorpera_company_state_run_folder(env, agent, coworkers)` gives the folder names of a
  `folder-v2` run's agent and of the coworkers its context lists (null for a `snapshot-v1` company
  or an agent without a folder). Core C1c-2's `folder-v2` body of `qorpera_describe_company_run_context`
  (RUNTIME-COMPANY-FOLDER-C1C.md §5.4) adds them as the context's optional `folder`, from the same
  coworker ids it lists, beside the company name from the vision index. The runtime's closed parser
  accepts `folder` like `serviceTier`, turns it into the place `cloudAgentFolder` takes
  (`agents/<handle>`, else `agents/<id>`), which memory and skills now both ask, and the prompt shows
  each agent's `folder`. Every `snapshot-v1` context and prompt keeps its exact shape. Older parsers
  refuse `folder`, so a bundle with this parser is active before C1c-2's `folder-v2` context sends
  one; no `folder-v2` company runs before C1c-3.
- Part B. `qorpera_prepare_routine_login(binding)` sets up the login the run's requester pays with for
  unattended work (`qorpera_ensure_unattended_sponsor`, which takes the login `FOR UPDATE` and writes
  rows), for the routine writer to call in its own transaction before it commits a routine file, whose
  commit reads that login without a lock. The consent and binding stay if the save is then refused,
  as the default consent an agent's save records today. It takes the run's job and then the login,
  as an agent's routine save does, so it can meet a member switching that login off (40P01): the
  writer retries it.
- Still to come: the vision in full (read through core C3's folder client), and the file's `model`
  and `effort` reaching runs.

**Core C3's folder client** (`packages/runtime/src/cloud-company-folder-client.ts`). The coordinator moved it
from F1 to F2 on 2026-09-29, and F1 reviewed its shape on #533. It is the run's client of the folder core's four
entry points: `read`, `readText`, `list`/`listAll`, `commit` and `release`.
- **Actor:** `{kind:'run', runId, jobId, runnerId, assignmentId}` from the binding. The client passes no fence and
  holds no lock between calls. Reads take SQL's plain checks; a commit or a release runs SQL's run check.
- **Commit:**
  - each file's bytes are staged through `CloudCompanyFolderBytes`;
  - every structured file in a write or a new folder carries `structured: [{path, kind, text, parse,
    parserVersion}]`, or `[{path, kind, problems}]` without the text, built by the shared parser from the same
    bytes. SQL decides every unit;
  - the operation key comes from the tool call. A retry with the same key, units and receipt replays the stored
    outcome, so `CloudCompanyFolderBytes.put` must return the same reference for the same bytes and media type;
  - `receiptId` carries the tool call's folder receipt once core C1c-2b has it. That receipt is the model-facing
    gate (lease, sponsor, wake and the wake work gate), bound to the one commit.
- **Outcomes:** `saved`, `conflict` (re-read, then redo under a new key), `refused` with `problems`, `denied` and
  `waiting_for_review`, each with SQL's reason.
- **Retries and errors:**
  - QRC01 (the authority changed after the commit decided), 40P01, 23505 (the structured hook's "taken by another
    change set") and 55P03 (a path claim that gave up waiting) are retried with the same key; a release retries
    QRC01 and 40P01 with the same id;
  - a lost answer (a timeout or a dropped connection) is retried the same way, since the transaction may have
    committed and a replay returns its outcome;
  - `CloudCompanyFolderError` says why a call did not complete: `stopped` (55000), `unavailable` (42501, 0A000),
    `read_revoked` (the recheck's "no longer readable": the model saw something it may no longer see), `contended`
    (still changing after four tries; nothing was recorded) and `unknown` (a try lost its answer or was cancelled
    while it was sent, and none answered after it: the caller retries later with the same key, units and receipt);
  - 22023, 25000 and PostgREST's answers about the request (`PGRST1nn`-`PGRST3nn`) are defects; its connection errors
    (`PGRST0nn`) are lost answers. SQL's words stay off the errors.
- **Open for C1c-2b (F1):** a commit carries at most one folder receipt, and a receipt one commit. A conflict's redo
  is a second commit, so under a receipt it needs 2b to refuse a used receipt with its own code under the receipt
  lock (the client must not read it as the hook's retryable 23505), or to leave the receipt unused by a commit that
  saved nothing. Until that is settled, the conflict rule above is for writers that carry no receipt.
- **Releases:** one per tool result that shows folder content, before the result leaves the tool. A listing's
  entries are reads too. The caller keeps the release id and the output hash with its tool call, because a replay
  with another output is refused. Composition releases once, before the first model request that uses it. A result
  that shows more than 10,000 entries is released in parts, each with its own id and the same output hash.
- **Bytes:** `CloudCompanyFolderBytes` is the one place core C1d plugs in (upload intents, and a byte check that
  never locks the company row). Until then a folder-v2 run moves no bytes: C1c-1 refuses its object upload and
  download. The client checks what it stages against its own hash, and what it reads against the entry.
- **Test 760** pins the four entry points' shapes, as the client parses them.

**The thin writers on it** go live after core C1c-2b (folder receipts; a writer that sends also needs 2b's send) and
C1d (bytes):
- first, `manage_todo` (a todo file, `writeTodoFile`), `organize_sidebar` (`agents/sections.md`, read and
  rewrite) and `decide_routine` (the run's own routine file: a new `at` or a conclusion,
  `setCompanyStateSettings`);
- after C2's review recorder (RUNTIME-COMPANY-FOLDER-C2.md, R1), `hire_agent` (one `new_folder` unit with `agent.md` and the first todo),
  `create_group_chat` (`group.md`) and `manage_routine` (a routine file, after `qorpera_prepare_routine_login`).

**How a thin writer saves** (W0, #583; W1):
- The runtime gives a run whose context names its agent's folder (`folder`) a `CloudCompanyFolderClient` over the
  object gateway's folder route (`HttpCloudCompanyFolderBytes`, on the native credential). A `folder-v2` agent without
  an indexed folder gets no `folder`, keeps the legacy tools, and they refuse.
- A writer first checks that its run can complete a folder receipt (`completesFolderCommits`), then reads the file
  and refuses what can never be saved. Every such check still passes once the call's own change is saved, so a replay
  of the call reaches its receipt and returns the stored result.
- Such a refusal is a `CloudToolRefusal`, which the tool boundary shows the model as `REFUSED: <reason>`: nothing
  started and no key is bound. Any other error inside a tool stays an unknown outcome, since an effect may have begun.
- It then saves under one receipt per tool call (`requiresCompanyRevision`), whose digest binds the model's request,
  not the version read. The commit carries `receiptId` and the `expectedVersion` read. Whatever the units' outcomes,
  the commit satisfies the receipt, which is completed with it (`qorpera_folder_complete_run_receipt`).
- A `conflict` (the file changed since it was read) comes back to the model, which calls again under a new operation
  key; a redo inside the tool would need a second receipt whose digest depends on a re-read.
- A result that shows content read from a file releases those reads with it, one release per tool call. A writer
  releases inside its effect, before the receipt completes: a release that fails after a saved commit leaves W0's
  fence (the call is not completed, and the run's later operations wait), which keeps a shown read from going
  unreleased.
- Known limit: the checks before the receipt read the file as it is now. If the file changed after a call's change
  was saved (closed, or deleted), a replay of that call is refused before it reaches its receipt, instead of getting
  the stored result. The change is still saved exactly once; only the replay's answer is wrong. A later fix can look
  up the completed receipt for that operation key first.

**Built (W1): `manage_todo`** (`packages/runtime/src/cloud-folder-todos.ts`).
- The todo is `agents/<handle>/todos/<todoKey>.md`; the todoKey is the file name (`^[a-z0-9]+(?:-[a-z0-9]+)*$`, at most
  64 bytes), and a wider key is refused with that rule.
- `upsert` writes the whole file (`writeTodoFile`), keeping an existing todo's id and requester; a new todo's
  requester is the run's, and the todos folder is made first when missing. A closed todo is not opened again.
- `done` and `cancel` change only `status` (`setCompanyStateSettings`), and show the todo as read, released with the
  result. An `upsert` that is not saved shows the state and version read, and releases that read too. A todo file
  that does not parse is refused, for a change and for `todoKey`.
- `list` reads the todo index (`qorpera_folder_agent_todos`, migration `20260928319770`, test 763), which the commit
  updates in the same transaction as the files: one plain read, paged as today's list (32 a page, newest first, open
  and blocked by default, `state`, `includeClosed` and `search` as before, the cursor of the last todo shown). A page
  shows the start of each detail, as today, and is no folder read, so nothing is released. `todoKey` reads that one
  todo's file and shows its whole detail, released with the result. A list shows no workers: `manage_worker` refuses
  `folder-v2` until F2-5b.
- The read takes the run's plain read check (no lock; a paused company refuses it), a company run that is not a
  worker, and read authority on the agent's todos folder. Each todo is listed only if the run may read its file (the
  core judges a file by its most specific resource, so one todo can be narrowed on its own); the count and the cursor
  follow the same rule. A deleted todo file is not listed.
- The index over the files is the coordinator's ruling of 2026-10-01; F1 may overrule it in a follow-up.

**Built (W2): `organize_sidebar`** (`packages/runtime/src/cloud-folder-sidebar.ts`).
- It reads and rewrites `agents/sections.md`. A section is named by its name, ignoring case; the file has no section
  ids. Lines before the first section (the company's own notes) are kept as they are; the sections are written back in
  the seeded form, each line an id and the words after it only for reading (a line keeps its words, indented or not;
  an agent placed for the first time gets its name). A name ending in `#` takes the parser's closing ` #`, and what is
  written must read back as the sections intended, or the call is refused before any effect.
- As today it is idempotent by content: a change already in the sections (their names in order, each with its ids in
  order) saves nothing and says so, however the file is laid out. `create_section` of an existing name is that
  section, a retried rename finds the new name, deleting a section leaves its agents Unassigned and deleting one
  already gone changes nothing, `move_agent` into the agent's own section changes nothing, and `move_agent` with
  `section: null` takes an agent out of every section.
- A change saves under a receipt keyed by the tool call (the tool has no operation key), with the version read; a
  `conflict` or a refusal by F2-2's hook (the Co-Founder, worded as today; an id that is not an agent or an open group
  chat) comes back as `refused`, with nothing changed, showing the sections as read.
- `list` and every result show the sections with names from the run context (the agent and its listed coworkers),
  then the unlisted as Unassigned (`unassignedTruncated` when the context's coworker list was cut). The Co-Founder is
  left out when it is the run's own agent; the context does not say which coworker is. Each result releases the read
  of the file it shows.
- A section reference ignores case and runs of spaces, as today. Differences from today: sections have no count cap
  beyond the file's 64 KiB (a change past it is refused before any effect), and an open group chat can be placed as
  well as an agent (§2).

**Built (W3): `decide_routine`** (`packages/runtime/src/cloud-folder-routine-decision.ts`).
- The run woken by its dynamic routine's `once` occurrence writes the decision into the routine's own file,
  `agents/<handle>/routines/<routineKey>.md`. `next` sets a new `at` (canonical, and, if asked, `effort` and `reply`)
  with `setCompanyStateSettings`; `conclude` sets `status: concluded` and the `conclusion`, its line breaks and tabs
  made spaces (the file's conclusion is one line).
- Refused before the receipt, binding no key (`REFUSED: …`): a title or instructions that differ from the file's
  (delegation, which the folder core cannot record until C2; equal ones change nothing), and a next run at or after
  the routine's `ends` ("The routine ends at …. Choose an earlier time or conclude it.", as today). The folder-v2
  description says the run leaves intent and title out, and that a refused decision is redone under a new key.
- Settled, as today, when the routine already moved on: its file is gone, it is no longer active, or it is no longer
  a `once` routine; and when the commit calls a plain decision delegation (`denied`, `review_required`), which by
  F2-6's review class means nothing is owed any more. A settled answer makes the decision.
- The save goes under the tool call's receipt with the version read. A saved decision is made (the run owes nothing
  more). A conflict or another refusal leaves it owed, and its reason says to decide again with a new operationKey.
- A `folder-v2` run on a node without folder bytes keeps the legacy tool, which refuses `folder-v2`: such a dynamic
  routine run cannot decide, and its final message is refused. Nodes serve folder bytes before any company is
  `folder-v2` (C1c-3).
- The routine is the one the run was woken for: the file at its key must carry its id (F2-6 keys the routine row by
  the file's id). When it is missing there, or another routine took the name, the agent's routines folder is listed
  and the file carrying the id is found (files that don't read as routines are passed over). Only when no file holds
  this routine is it settled. The wake is not read again: that read also claims the run's held coworker messages.
  The receipt's target stays the woken path, so a retry after a second rename is the same call. A settled answer
  that shows the routine as read releases that read. Known limit: a rename of the agent's own folder mid-run is not
  followed (the run context names the folder once); the decision is then answered settled while the kernel may still
  owe it.

**Built (W4a): `hire_agent`** (`packages/runtime/src/cloud-folder-hiring.ts`), on C2's review recorder
(RUNTIME-COMPANY-FOLDER-C2.md, R1).
- One `new_folder` unit `agents/<handle>`: `agent.md` (`writeAgentFile`: kind `agent`, status `active`, the figure,
  `jobDescription` as the instructions), the folders `memory`, `skills`, `routines` and `todos` (as the Co-Founder's
  seeded folder), and `todos/first-assignment.md`: the first assignment as an open todo, asked for by the run's
  requester, titled with the assignment's first line (one line, at most 200 bytes).
- The handle is the name as a folder name, numbered past the names taken under `agents/` and the reserved ones
  (`freeCompanyStateName`), from a listing taken before the receipt. The agent's and the todo's ids come from the run
  and the operation key (the legacy hire's id format, in a namespace of their own). A rebuilt call may pick another
  handle; what makes it harmless is the receipt, whose target is the agent's id, so a completed call replays.
- Checked with the arguments, before the automatic review (`INVALID_ARGUMENTS: …`), so no card is raised for a hire
  that cannot be saved: the files the shared parser refuses (its problems), a first assignment over 4000 bytes (a
  todo's body; the schema counts characters), and an operation key reused in this run with other arguments.
- Refused before the receipt (`REFUSED: …`): a call without the automatic review's approval (`actionReviewId`).
- **Contract 14.1, the restricted hire** (migration 20260928399940): an agent that cannot delegate the new agent's
  default access (a current, nonexpiring read and write grant on every live shared root, the legacy hire's predicate,
  `qorpera_folder_agent_delegates_default`) hires only on an owner's or admin's answer. The review's layering asks the
  owners and admins on a card for its `hire_agent` call, whatever the reviewer found (a deny stays a deny; a denied
  hire retried asks them too), as an access check no rule lifts, with no Always allow. The card says why it asks and
  keeps the reviewer's own reason unless the reviewer simply allowed it; a not-asked-for finding stays the built-in
  check. The recorder checks again before the save and records such a hire only from an answered owners-and-admins
  card: a member's answer on a card of their own, given while the agent could still delegate, does not carry over (an
  owner's or admin's does). Where no owners-and-admins card can be raised (a group chat, a worker, a member's private
  conversation) the hire is refused, as any ask there. The recheck runs in the recorder's transaction; a
  restriction between it and the commit (milliseconds) is like a restriction just after the hire.
- Under the receipt: stage, record the review of exactly these units (`recordReview` with the tool and the call's
  argument digest), commit them with the review. Saved: the agent exists and is indexed with its thread; the commit
  names the review. A conflict (the folder was taken meanwhile) or a refusal says to call again with a new key.
- **The new agent does not start by itself** (open with F1): no first run is queued for a `folder-v2` hire yet. The
  result tells the model to wake it with `send_coworker_message` to the agent's id, asking it to start on its first
  todo, and to tell the member (and, if that send fails, that the agent has not started). A hire that waits for a
  member's review says not to hire again.
- A `folder-v2` run on a node without folder bytes keeps the legacy tool, which refuses `folder-v2`, as for W1–W3.
- Known: the Co-Founder's hire overlay still says agent descriptions live under `organization/agents`; its
  `folder-v2` wording comes with F2-1b's context work.
- SQL test 774: a run's hire round trip on the recorder (denied without its review or with a review of other units;
  saved and indexed with it; a taken folder is a conflict; the agent rules still refuse a Co-Founder or a taken id;
  the predicate case by case (a revoked, read-only, finite, other-version or other-agent grant, an archived agent, a
  second environment's root and its revocation); the restricted hire asks the owners and admins with no Always allow,
  also on a retry, its own allow and an earlier member's answer are refused by the recorder, and an owner's answer
  saves it with that owner as approver). 652's pin of the layering's snapshot-v1 text strips the `folder-v2` lines.

**Built (W4b): `create_group_chat`** (`packages/runtime/src/cloud-folder-group-chats.ts`), as W4a.
- One `new_folder` unit `agents/groups/<handle>` with `group.md` (`writeGroupFile`): the name, no subtitle (the app
  shows "Group chat"), the purpose as the body, `agents` the run's own agent and the coworkers named, `people` the
  run's requester unless `includeRequestingMember` is false (an agent's change may add only that member; SQL refuses
  any other). `agents/groups` is seeded and can be neither deleted nor moved, so it is always there.
- The handle is the name as a folder name, numbered past the chats under `agents/groups/` (no reserved names
  there); the chat's id comes from
  the run and the operation key (`qorpera.folder-group/v1`) and is the receipt's target. The commit opens the room
  (`chat-<id>`) and its conversation with those members.
- Checked with the arguments, before the review: the file the parser refuses, and a reused operation key. Refused
  before the receipt: a call without the review's approval. Under the receipt: stage, record the review
  (`create_group_chat`), commit. Saved: tell the member the chat's name; a conflict, a refusal or a waiting chat
  says what to do. Contract 14.1's restricted rule is a hire's only.
- SQL test 777: a run's chat round trip on the recorder (denied without its review; saved with the room, its agents
  and the requester as members; another member refused; an archived coworker refused; a lone agent refused by the
  file's own rule).

**Plan (W4c): `manage_routine` and `decide_routine`'s rewrite** (design, round 3 approved with nits; W4c-1 and W4c-2
built, below). Both write
the run agent's own routine files, `agents/<handle>/routines/<routineKey>.md`, as W4a and W4b do: the file is checked
with the arguments, before the automatic review; every other refusal comes before the receipt; under the receipt the
change set is staged, its review recorded (`manage_routine`, `decide_routine`) and committed with it. No
restricted-creator rule applies (contract 14.1 is a hire's only); the old listener checks come back when event and
file-change routines move to files.

*The index and its read (W4c-1, SQL).* The platform records some pauses in the index only, until C2's follow-up queue
writes them into the file: an authorization-failure suspension, a member's Stop, a wait for a model account. The file
then still says `active`. So:
- **A save that changes nothing is a resume.** A save by anyone but the platform whose file says `active`, with the
  same parse as the file the routine follows (which also says `active`), while the routine row is `paused` for one of
  the platform's reasons (`member`: a member's Stop; `authorization_failed`; `needs_model_account`), ends that pause.
  Every pause that comes from a file leaves a file saying `paused`, so a paused row behind an active file can only be
  the platform's. The test goes into `qorpera_company_state_routine_restarts`, so the save pays like a resume and the
  rules' check refuses a member without a paying login (who would otherwise turn a Stop into a wait for a login). The
  index writer then takes the saver's word (`active`, failures reset) even without a new version: a wait for a login
  pinned to the login that now pays ends too. An unpaid resume (a run whose requester has no paying login) keeps the
  platform's pause and its reason. An edit still leaves a Stop or a suspension in place, as today (an edit that makes a
  new version with a paying login already ends a wait for a login). A member's save of the unchanged routine in the
  app, even one that changes only notes or layout, resumes it the same way, and a member without a paying login is
  refused it. Built as a pure helper `qorpera_company_state_routine_resumes(row, previous parse, parse, actor kind)`
  that `qorpera_company_state_routine_restarts` (now with the actor's kind) also answers true for, and `or (resumes and
  paid)` in the index writer's word on the status. C2's queue,
  when it writes the platform's pauses into files, must not write a pause the row no longer holds.
- **A read of the run agent's routines**, `qorpera_folder_agent_routines(environment, actor, request)`, as W1's todo
  read: a plain read of the index for the run agent's file routines, each only if the run may read its file, with the
  key, title, instructions, trigger, `ends`, `runs`, quiet hours, effort, reply, the status in the file and the
  status in the index with the platform's pause reason, the next run and the runs used, paged with a cursor as W1's.
  Routines from before the company's folder (they still hold their names) are not listed. `routineKey` reads one. Any
  run of the agent may read, a member's private conversation included (`manage_routine` is offered there), each file
  by the run's own read authority; a worker may not, as in W1. It joins the client's RPC lists and the pinned test.

*`manage_routine` (W4c-1, runtime).*
- `routineKey` is the file's name: lowercase letters, digits and single hyphens, at most 64 characters (refused with
  the rule otherwise; the legacy key allowed dots, underscores and 96 characters).
- `list` shows the read's routines, as many as fit the result (W1's rule), with the cursor for the next page;
  `routineKey` shows one in full.
- `upsert` writes the whole file with `writeRoutineFile`, as today's upsert replaces the whole routine (the list shows
  every field to restate): `every` → `when: every` (`minutes`, `starts`); `weekly` → `when: weekly` (`days`, by
  default Monday to Friday, `time`, `timezone`, `starts`); `dynamic` → `when: once` (`at`: `firstRunAt`, else a still
  future `at` of the file, else now; `timezone` required); `expiresAt` → `ends` (in the future, as today);
  `maxOccurrences` → `runs` (not for `dynamic`); `quietHours` → `quiet` and its time zone (`every` has none, so the
  quiet hours carry their own); `report` → `reply` (absent: `optional`); `effort` (absent: the file's, else medium).
  `status: active`: a save revives a paused, concluded or expired routine (an expired one ends again while its end
  has passed, so an `ends` in the past is refused). A new file gets an id from the run and the operation key; an
  existing one keeps its id. A missing `routines` folder is made in the same change set. `file_change` (core C4) and
  `event` (F2-6b below) are refused with the arguments. An upsert that would save the unchanged file over the
  platform's pause (the same parse) answers before the receipt "nothing to change; to switch it back on, use resume",
  so the review sees a resume as one and a repeat of a saved edit is not refused.
- `pause`: `status: paused` (a pause in the file). A file that already says `paused` answers "nothing to change" (no
  review is recorded, no commit), as W2 does, so a repeat of a saved call is not refused; a concluded one is refused ("concluded; save it
  again to restart it").
- `resume`: a file that says `paused` becomes `active`; a file that says `active` while the index shows the platform's
  pause is saved unchanged (the resume rule above). A routine active in both answers "nothing to change"; concluded
  ("save it again to restart it") and ended ("it ended; save it again with a later end") are refused, as today. The
  approval card for a resume says that it switches the routine back on, also after a member's Stop or a suspension.
- `conclude`: `status: concluded` with the `conclusion` (one line, at most 2000 bytes); already concluded answers
  "nothing to change". Concluding the run's own dynamic routine settles its owed decision for the host, as today.
- `remove` deletes the file (a `delete` unit with the version read): the routine retires and its name is free again
  (today's remove kept the key taken). Reviewed as a deletion; the call's approval covers it.
- The run's own routine: `pause` and `remove` in its own run, dynamic or fixed ("conclude it instead": a fixed
  routine's pause would stop the run itself; SQL refuses it for a dynamic one); and while a dynamic routine's decision
  is owed, every action but `list` and `conclude` ("use decide_routine"), as today and contract 16.3. A dynamic
  routine's key is known with the arguments, so those are refused there, before the review, as today; a fixed
  routine is known by the wake's routine id, so its run's refusal comes before the receipt, by the file's id. Every
  other refusal that needs the file or the index comes before the receipt.
- Login, last before the receipt: `upsert` and `resume` (the saves that start or extend work) call
  `qorpera_prepare_routine_login` (new to the client's RPC lists; a deadlock is asked again, as STATE-FILES §5
  says). Its refusals (the wake's acknowledgement, a paused company, a final reply already sent) come back as
  `REFUSED` in the runtime's own words; any other error stays an error. When it finds no paying login (`login:
  null`), `resume` answers before the receipt that the routine keeps waiting until the member connects a model
  account, and does not save (a resume would change nothing). Unlike today's tool, the consent it records stays if the save is then refused;
  it is the requester's standing consent, and the same call records it again.
- After the commit, the result reads the routine back from the index, best effort (a failed read never turns a saved
  change into an error; the result then says to list it): the outcome, the reason and problems, and the routine as it
  now runs (status, the platform's pause reason, the next run). A routine waiting for a model account says so, and
  the model tells the member (folder-v2 queues no member notice until C2).
- A folder-v2 description replaces "No member approval is needed". The approval card keeps reading today's compiled
  arguments.

*`decide_routine`'s rewrite (W4c-2).*
- A decision whose `title` or `intent` differs from the file is no longer refused: with the review's approval it
  writes the new title and instructions with the decision (`writeRoutineFile` from the file's parse, which keeps
  every other key), stages, records the review (`decide_routine`) and commits. The gate never raises a card for
  `decide_routine`, so only a reviewer's allow reaches it; an ask is refused there and the run decides without the
  rewrite, as today.
- Settled before the receipt when the routine's end has passed (nothing is owed: a rewrite would revive it), as today.
- Without an approval the rewrite is refused before the receipt, as today.
- `denied` with `review_required` stays "settled" only for a decision without a rewrite (F2-6's class: nothing owed any
  more). After a recorded review it is reported as not saved, with the instruction to decide again without the
  rewrite. The folder-v2 description stops saying the title and instructions cannot change.

*Follow-up (F2-6b, F2's):* `when: event` in the parser and SQL's parse shape, the folder-v2 wake gate's event refusal
lifted and the folder wake read's event batch (EVENT-INTAKE: "whichever of W2 and F2-6 lands second"; neither did).
Event routines need hooks on folder-v2 and runs from folder wakes (C1c-3, C4) before they work end to end.

*Tests.* SQL: the resume rule (an unchanged save ends a failure suspension, a Stop, and a login wait only with a paying
login; an edit does not end a Stop or a suspension; the platform's save does not; a member without a paying login is refused; a member's own
file pause is untouched), the read (authority per file, one key, pre-folder rows left out), a run's routine save,
pause, resume, conclude and removal on the recorder, and a dynamic rewrite (a routine-run fixture with a native
binding, from 708's `routine_run` and 647's `native`). Runtime: each action and refusal on the writer fixture (which
learns routine files as delegation, the routine read and the login preparation), the folder description and wiring,
the own-routine refusals, and `decide_routine`'s rewrite.

**Built (W4c-1): `manage_routine`** (`packages/runtime/src/cloud-folder-routines.ts`; migration 20260928399960), as
planned, with these choices made while building:
- SQL: `qorpera_company_state_routine_resumes` and the four-argument `qorpera_company_state_routine_restarts`, patched
  into the rules and the index writer by exact anchors. `qorpera_folder_agent_routines` returns
  `qorpera_agent_routine_view` without `intent` (the file's `instructions` say it once), plus `path`, `folderVersion`,
  `file` (the parse) and `cursor`. A page cuts each routine's instructions to 200 characters and marks it
  `instructionsTruncated`, as W1 cuts a todo's detail, so a page fits one 8 KiB tool result; `routineKey` reads one
  whole. The runtime reads it with a 1 MiB response bound. It and the login preparation (`qorpera_prepare_routine_login`,
  20260928269440) join the client's RPC lists; the login preparation is a run effect called with the binding, as the
  recorder is. A row from before the folder has no folder environment, so the environment match leaves it out (and its
  missing path fails the per-file check too).
- The resume rule keys on the commit's actor kind. A future index rebuild (§4) must save as the platform, or it would
  end every platform pause behind an unchanged file.
- `list` takes a `routineKey` or a `cursor` (not both) in a folder-v2 run and shows, for each routine, how it runs now
  (status, the platform's pause reason, the next run, the runs used) and what its file says. Index reads are not
  released (W1's ruling). One routine whose instructions do not fit one 8 KiB tool result is cut, at a character, to
  fit and marked `instructionsTruncated`; any cut result says to read the routine's file (`company_read`) before
  restating its instructions in an upsert, which writes the whole routine.
- In a folder-v2 run the tool's schema offers the file name rule for `routineKey` and only the clock triggers, and an
  operation key reused with other arguments is refused with the arguments, before the review (as W4a and W4b).
- `upsert` maps the compiled trigger: `every` (no time zone; quiet hours carry `quiet_timezone`), `weekly` (days
  `mon`..`sun`, `time`, `timezone`, `starts`), `dynamic` (`once`: `firstRunAt`, else the file's `at` while it is
  ahead, else now). The receipt binds the request as parsed; defaults filled in are not part of it. An upsert whose
  parse equals the file's answers "nothing to change" (pointing at resume over the platform's pause, or at a later
  end over an ended routine).
- `pause`, `resume`, `conclude` edit the file's settings (`setCompanyStateSettings`); a resume over the platform's
  pause saves the same bytes. `remove` is a `delete` unit at the version read; a repeat after the file is gone answers
  "nothing to change". The routine that woke the run (any routine wake, by its id) cannot be paused or removed.
- A conclusion is checked with the arguments too: the summary on one line, over a placeholder routine file.
- Before the receipt, after the file read, the index read and the answers that change nothing, in this order: the
  review's approval (without it nothing more happens), the routines folder
  read, then the login: `upsert` and `resume` pin it last. Any resume with no paying login answers before the
  receipt (a file pause would only turn into a wait for one). The wake's refusals (`55000`: the acknowledgement owed,
  a final reply sent, a paused company) are refusals in the runtime's words; others stay errors.
- After a save, once the receipt is complete, the result reads the routine back from the index, best effort (outside
  the stored result, so a slow read never turns a saved change into an error), and says what a paused result still
  needs (a model account, a working account, a member's Stop). A removal shows no version.
- The approval card for a resume adds that it switches the routine back on, also after a member's Stop or a failing
  account.
- Tests: SQL 780 (the resume rule and the read: a file narrowed to another agent left out of the page, its count, its
  key and its cursor; a removed routine and one from before the folder left out; workers and views refused; another
  agent's routines left out; one key; a cursor; the cut) and 781 (a run's new routine, pause, resume, an unchanged
  save over the platform's pause, conclusion and removal on the recorder; a new routine and a removal not saved
  without the review; a dynamic routine's run cannot pause it, even with the review, since SQL leaves a fixed
  routine's own pause to the runtime). 781 takes the C5-early fixtures' possession step when they have it. Runtime: the writer on the
  writer fixture (routine files as delegation except the run's own dynamic routine's decision, a routine index with
  SQL's resume rule, the login and its payment), the client's two calls, the control's bound, the tool's folder path
  and the runtime's wiring.

**Built (W4c-2): `decide_routine`'s rewrite** (`packages/runtime/src/cloud-folder-routine-decision.ts`), as planned:
- A `next` whose title or instructions differ from the file writes the whole routine from the file's parse
  (`writeRoutineFile`, every other key kept) with the new `at`, effort and reply, then stages it, records the review
  (`decide_routine`) and commits it under the receipt. A plain decision is saved as before (`setCompanyStateSettings`,
  no review recorded); a title or instructions equal to the file's change nothing.
- With the arguments, before the review: a new title or instructions are checked as a routine file over a placeholder
  dynamic routine (a title is one line, without tabs or other controls). Before the receipt: the rewritten file is
  parsed again; a rewrite without the review's approval is refused (decide again without intent or title); a
  conclusion with a new title or instructions is refused (the tool's schema never sends one); a routine past its end
  is settled, since nothing is owed and a rewrite would revive it.
- What keeps a rewrite from reviving a routine no longer owed: a paused routine's run cannot decide at all (it lost
  its wake authority, so the call fails, as in W3), and for a routine that expired while active the runtime's past-end
  settle is the only guard (a reviewed rewrite would be saved and make it active again). The window between that check
  and the commit is harmless: the scheduler never queues a run at or after the end, and the sweep expires it again.
- After a recorded review the core never answers `review_required` for that change set; the branch that reports such a
  rewrite as not saved (the decision stays owed) is defensive. A plain decision answered so is still settled (F2-6's
  class).
- The folder-v2 description keeps the intent and title text and says a new intent or title goes through the
  automatic review. The gate's answer to an ask is unchanged (decide again without them).
- Tests: SQL 781 §7 (a dynamic routine's run cannot pause it even with the review; its rewrite is not saved without
  the review and the decision stays owed; with `decide_routine`'s approval recorded it is the decision, a new version
  with the new title and instructions). Runtime: the rewrite on the writer fixture with its recording, the instructions
  alone, a renamed file, a plain decision with none, the recorder's refusal (the decision stays owed), the core's
  refusal of a rewrite, the checks with the arguments and before the receipt, the routine past its end, the
  descriptions.

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
   `agent.md`, and the agent-folder helper for memory and skills. Part A (migration
   20260928269440) is the folder names for the context and the helper (§5); part B, in the
   same migration, the routine save's login setup; the thin writers come on core C3's folder
   client, and the reviewed ones after C2's review recorder.
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
6. **F2-5** todos and worker files: **F2-5a** todos (migration 20260928259210); **F2-5b** worker
   briefs and results, with core C3's writers: the worker tools commit them as the run (see
   "Plan (F2-5b)").
7. **F2-6** routines (migration 20260928259310), last because the scheduler, schedule positions
   and decisions are the most delicate part. `file-change` routines came with core C4 (P29).

Each step comes after F1's C1 (C1b brings the call sites), is `folder-v2` only, rides the release
train, and gets an independent exact-head review. The web screens for each kind follow with
core step C4.

**Plan (H1): human tasks and contacts, the formats** (Q1 §5; design reviewed by Q1 and in an
independent review). Inert: no index, no database rule but one (only the platform marks a secret
saved), no seeding. Two PRs, released in this order:
- **H1a, the parser** (no SQL): the two kinds in `companyStatePath`; their keys, limits and
  cross-key rules (§2); the steps grammar; the canonical writers `writeHumanTaskFile` and
  `writeContactFile`; the path checks for the file names and for the folder places `human-tasks`,
  `contacts`, `human-tasks/<t>` and `human-tasks/<t>/proof` (`companyStatePathProblems`,
  `structuredFolderNames`). Released first, to every writer that sends structured entries (the
  runtime bundle active, the object gateway and the folder service deployed), since SQL refuses
  a structured key that carries no parse (`qorpera_company_state_checked`), and a writer sends a
  parse only for the kinds its parser knows.
- **H1b, the database** (one migration, 20260928429900, after H1a is live). It replaces:
  - `qorpera_structured_path_kind`: `human-tasks/<name>.md` and `contacts/<name>.md`;
  - `qorpera_structured_folder_names`: the four folder places;
  - `qorpera_company_state_path_problems`: the file name at position 2 for both kinds;
  - `qorpera_company_state_parse_problems`: the two shapes, their limits and cross-key rules,
    as for the kinds already indexed, so H2's index can trust what is stored;
  - `qorpera_company_state_checked`: its list of shape-checked kinds;
  - `qorpera_company_state_carried`: its roots gain `human-tasks` and `contacts`, so a folder
    move or copy into or out of them is `kind_change` or `structured_copy` (without it, moving an
    ordinary `drafts/` into `contacts` would land files with no parse, and moving `human-tasks/`
    away would quietly make every task ordinary);
  - `qorpera_folder_structured_decide`: one rule, `secret_state: saved` only from the platform,
    unless the file the save replaces had `saved` with the same `id` and `secret`.

  The review class stays plain, and no index, lock target or verify row is added.
- **Before H1:** a file saved at these paths while they were ordinary (only an operator's test
  companies can have one) can then only be replaced by a file that parses, moved within its root,
  or deleted: a move out is a kind change. H2 says how it treats a structured key whose current
  version has no parse.
- **Contract:** the amendment of 2 October (work for people, approved 3 October) writes Jonas's
  decisions 4 and 5 into 5.6 and widens 16.1's last step to contacts; 5.6's and 16.1's text
  carry it since 3 October. The seeding code is H2's.
- **Tests:** the parser's cases and round trips; the comparison lists, both kept by hand
  (`supabase/tests/700_folder_state_vision_agents.test.sql` §7 and the kinds test in
  `packages/cloud-client/test/company-state-files.test.ts`), with the new spellings; and SQL test
  785: the shapes and limits, `human-tasks/my_task.md` and a `human-tasks/T/proof` folder refused,
  a folder move of `drafts/` into `contacts`, of `human-tasks/` out and a folder copy of
  `contacts/` refused, the secret rule, and no index.

**Built (H1a): the parser** (`packages/cloud-client/src/company-state-files.ts`), as planned, with these choices made
while building:
- A contact's `asks` entry may not start or end with a space (a quoted entry could keep one), since the database's
  shape check holds one-line values trimmed.
- `asks` and `files` are the first free-text lists, so a plain item YAML reads as something other than text
  (`true`, `42`, `null`) is refused with `quote`, as the settings' text fields are; the writers quote such items.
- `files` entries are held to the core's path rule, so a task never names a path that rule refuses (the commit's own
  key limit of 2,600 bytes is not checked here).
- No `computer` key (A1, 2 October): a takeover step is always done on the asking agent's own computer, which the
  platform finds from `from` when the person opens the task, also when a company runs several machines. The file
  names nothing that can go stale; `step` and `connection` say what to do and for which account.

**Built (H1b): the database** (migration 20260928429900, SQL test 785), as planned, with these choices made while
building:
- The seven functions are patched by exact anchors, each of which must match once or the migration stops, so a
  definition changed since is caught rather than overwritten. Each patch carries the marker `20260929999000` in a
  comment inside the function body, which the deploy guard reads.
- A parse that breaks a rule is refused as for the indexed kinds: one problem naming the rules it breaks ("the
  platform read this file differently from its rules (files)"). `files` entries are held to the core's path rule
  (`qorpera_company_path_valid`) and to one line. On 371,581 generated paths the rule agrees with
  `parseCloudCompanyPath` but for one, `conİn$`, which only the database refuses (it folds `İ` to `i`, giving the
  reserved name `conin$`; §1's case, failing closed).
- The secret rule reads the stored parse of the version the save replaces (the current version at the same key), as
  the agent rules read their base, and refuses with `structured_rule` and the problem on `secret_state`. A move keeps
  the file's bytes and so its mark; a copy of a task file is refused anyway (`structured_copy`). 785 §6 holds a
  member, an agent's run (the decision its commit takes) and a new folder's file to it.
- A folder with no `.md` file directly inside it may still be moved or copied onto `contacts` or `human-tasks` while
  that root does not exist: what lands there is ordinary (`x/sub/a.md` becomes `contacts/sub/a.md`), and under
  `human-tasks` its folders must also pass the task-folder name rule.
- A task or contact save takes no lock and its review class stays plain (785 §7).
- Proof besides 785 and 700 §7: 6,000 random files written by `writeHumanTaskFile` and `writeContactFile`; every parse
  the parser accepted (4,962) passes `qorpera_company_state_parse_problems`. 81 mutants of the migration (every rule,
  limit, place and root, both review rounds' included) are each caught by 785.

**Plan (H2): human tasks on the folder core** (Q1 §5's H2: "the index, who may set which status,
`human-tasks/` and `contacts/` seeded in every new company, and the wake of the asking agent on done,
declined and overdue"; §2's "What H1 does not decide"). Stacked on H1b. Still no web screen (H3), email
(H4) or contact link (H5). Revised after design review r1 and Q1's answers.

What the core gives H2, and what it does not (inventory of 2 October):
- A unit is atomic; a change set is not. Each unit is decided and applied on its own, and a later unit
  sees an earlier one's result, so two units cannot be made to land together.
- Actors are `member {userId}`, `platform {}` (no other field), and a run or view. The hooks see a run,
  and an agent's view, as `staff_agent {staffAgentId, runId, requesterUserId, ...}`; a member's own
  desktop view as that `member`. No actor speaks "for" a member.
- No member can write a folder-v2 file yet: the web and the object gateway write snapshot-v1 only, until
  C4, and a member's desktop gets its folder with F3. The only folder writer in production is the
  runtime's run client.
- The commit never inserts a wake. Folder-v2 wakes are queued by run effects and delivered once C4 adds
  their drain; C4 also brings the folder listener (core §6), which reacts to commits after they land.

**1. The person, and the person's change.**
- A member's task: the person is the member named in `member`, and the person's change is a commit by
  that member's own actor (Q1 agreed). A member who creates a task naming themselves creates it as the
  company; from then on they are its person. The person never acts as the company's side on their own
  task, whatever their role, so nobody accepts their own work.
- `member` must name a member who can write the company's shared files (owner, admin or contributor);
  a viewer is never a task's person. Outside people are contacts (Q1).
- A contact's task: the person has no account. Only the task link service (H5) makes the person's
  change, as the platform, through the writers' shared helper (H2a). SQL cannot tell the link service
  from another platform writer, so this is H5's rule.
- On a member's task file the platform may only set `secret_state: saved` (H1b's mark, for the vault
  writer); on a contact's task file it may also make the person's change. It never creates a task: an
  agent's run or a member writes it (A1's takeover tasks are written by the agent's run). Its folder
  rights are §4's.
- The person's change may only (Q1):
  - tick or untick boxes: the body is the same with every box mark (`- [ ]`, `- [x]`, `- [X]`) read
    as one, and `steps` keeps its order and texts (compared by position and text; the line numbers move
    when `reason` comes or goes);
  - `open` or `returned` → `done`, removing any `reason`, once the proof exists (below);
  - `open` or `returned` → `declined`, with its `reason`.
  Every other key stays as it was. The person's change is plain (not reviewed), and its references are
  not checked again (§3).
- Proof: the writers name each file `human-tasks/<t>/proof/<kind>-<n>.<ext>` (`photo-1.jpg`,
  `signature-1.png`, `file-1.pdf`), directly in `proof/`, and the note `human-tasks/<t>/note.md`.
  `done` needs every kind `proof` lists (Q1): at least one file directly in `proof/` whose key starts
  with `<kind>-`, per listed `photo`, `file` or `signature`, and a `note.md` of more than 0 bytes when it
  lists `note` (SQL never reads the bytes). After `returned` the old proof still counts; the agent
  judges it.
- Q1's "the platform saves the proof and the status in one step" becomes two units, proof first, then
  the status: the second sees the first.

**2. The company's side** (agents, members who are not the person, and the platform only as in §1):
- A new task is `open`, with `due` in the future.
- `accepted` and `returned` come only from `done`. `returned` needs `reason` and a `due` in the future,
  and the task is the person's again.
- `cancelled` comes from `open`, `returned` or `done`; from `done` it needs `reason`, so the record says
  why finished work was set aside (Q1). The proof stays.
- `accepted`, `declined` and `cancelled` are final: no later save changes the file. Only a final task
  may be deleted (§4).
- `done` and `declined` are the person's only.
- Changing `member` or `contact` hands an open or returned task to someone else; `due` may move to any
  time in the future. `from` may change only while the asking agent is no longer active, only to an
  active agent, and only by a member or the Co-Founder (Q1: "escalate to the Co-Founder"); `todo` is then
  cleared or names an open or blocked todo of the new `from`.

**3. Ids and references**, checked when a save sets or changes them, as todos check `requested_by`;
never on the person's change, so nothing the person does not control can refuse their work:
- `id` is unique among the tasks of the environment and never changes; the same holds for contacts.
- `from` is an active agent of the company. An agent's run creating a task writes its own id.
- `member` as in §1. `contact` is a contact file of this environment with an `email`.
- `connection` is a connection file of this environment.
- `todo` is an open or blocked todo of the `from` agent, checked whenever either key changes, so a task
  never wakes another agent's todo.
- A contact named by a task that is not final stays: its file is not deleted or moved out of
  `contacts/`, and its `email` is not removed. To erase such a contact, cancel its tasks first.
- A file saved before H2 (or a version with no parse) is trusted for its shape only: its base counts
  only when the index points at its path, as for todos. Until it is saved again, such a task has no
  status for §4: it counts as no task, and a member or the platform may delete its file as it may an
  orphan folder.
- A restore (a task file written again after its delete) compares with the task's last file, as todos
  do, so a restored final task stays final and is never read as a new task.

**4. The task's folder and its file.** File and folder are siblings, so they need two units, and two
units cannot land together. The rules keep a folder from ever outliving its task:
- Nothing lands at `human-tasks/<t>` or under it (a write, mkdir, new folder with its contents, or a
  move's or copy's target, each carried descendant included) while `human-tasks/<t>.md` is absent. The
  platform is held to it too.
- A new task file, or a task file moved to a new name, is refused while a folder of that name exists.
- A task file whose folder exists is neither moved nor deleted: a task with proof keeps its name (Q1
  agreed), and its folder goes first. A task file is renamed or removed only by the company's side: never
  by its person, and never by the platform on a member's task.
- Directly under `human-tasks/` there are only task files (`*.md`) and task folders; another plain file
  there would block a task's folder.
- Under `human-tasks/<t>/`, by the task's status:
  - `open` or `returned`: only the person (the platform on a contact's task) writes, moves or deletes;
  - `done`: nobody changes it, while the agent checks the proof;
  - final: a member or the platform may delete the whole folder (not single files in it); agents never;
    nobody writes.
  A folder without its task file (made before H2, or by an operator) may be deleted by a member or the
  platform, and nothing else.
- Removing a final task with proof takes two units, folder first, then the file. This may leave a task
  without proof, never proof without a task.

**5. The index.** Two tables in the connection index's style (no foreign key to the company; written in
apply; a move repoints, a delete retires, a restore revives; `verify` checks each written row), keyed by
`(environment_id, id)`, so one company's ids never block another's:
- `qorpera_folder_human_task_index`: path, version, commit, retired_at, status, title, member, contact,
  from, todo, connection, due, and `started_by_user_id`: the member who started the task (the creating
  commit's requester; a member's own id for their own commit), who pays for the wakes (H2c).
- `qorpera_folder_contact_index`: path, version, commit, retired_at, and whether the file has an
  `email`.
Both hold what the files say, so a rebuild (§4) makes them again, except `started_by_user_id`, which comes
from the creating commit, as a routine's `origin` does: a rebuild keeps it. The path index is not unique,
as the connection index's, so `apply`'s update never needs more than its rank-5 lock. The wake markers are
runtime state and live elsewhere (H2c).

**6. Locks** (per row, rank 5, in the company's own rows; no company-wide lock).
`qorpera_folder_structured_lock` learns the two tables, after its current ones:
- every unit whose `apply` writes a task's or a contact's index row (a save, move, delete or restore of
  the file): that row, FOR NO KEY UPDATE;
- any unit at or under `human-tasks/<t>`: that task's row, FOR SHARE, so proof, folder and status
  changes serialize, and two removals of one task never deadlock;
- a task save that sets or changes `contact`: the contact's row, FOR SHARE.
`targets` finds a row with an unlocked read and names it `required: false` (a new or pre-H2 task has
none). `decide` gets no target list and cannot lock, so it refuses the unit as a conflict when the row at
`<t>.md` was last written by a commit whose `seq` is later than this commit's `as_of_seq`: sequence order
is commit order, so any change since `targets` read the row is caught, with no core change.
Read without a lock, and accepted: a todo closed, an agent archived, a member made a viewer or a
connection removed at the same moment as a save that names them. Each leaves a task naming something no
longer current, which the wakes (H2c) report or §2's hand-off repairs.

**7. Seeding.** `human-tasks/` and `contacts/` join `companyStateSeedTree` and the seeded folders that
are never deleted or moved (`COMPANY_STATE_SEEDED_PATHS`, `qorpera_company_state_seeded`), with the seeded
skill `skills/human-task/SKILL.md` (how to write a good task, Q1 §5). Jonas said yes on 2 October: both
folders are fixed in every company, like `connections/` (contract 5.6's tree and its list of seeded
folders, written in). Existing folder-v2 companies (operator test companies) get the two folders from the
operator's `mkdir`, and no skill.

**8. Review class.** Plain for both kinds: creating or changing a task is inside the company (Q1 §5). H5
must pin what it sends, as H1 pins the files, address and expiry: a contact's page shows the task as of
the reviewed send, and a newer version needs a new reviewed send. A contact's proof and note are outside
content (11.1), which H5 marks.

**9. Wakes (H2c, with C4's listener).** The commit never inserts a wake, so the person's save can never be
refused or rolled back by a wake. The coordinator agreed (2 October): H2c is F2's, a stacked draft
against C4's listener interface, which the H2 PR body proposes:
- C4's folder listener (core §6) reads landed commits and queues one wake of `from` for each status
  change or reassignment made by anyone but `from` (done and declined above all; Q1: "when the status
  changes"), and one wake of the new `from` on a hand-off;
- a timed scan, one company per transaction, over a partial index of open and returned tasks by `due`,
  queues one overdue wake per (task, `due`); a return or a new `due` re-arms it. Time passing is not a
  commit, so the listener alone never sees it;
- the pin trigger and `qorpera_folder_wake_authorized` accept an `agent` wake with source kind
  `human-task` and no parent run;
- the payer is `started_by_user_id` (S2: the member who started the work pays); when that member has
  left, the requester is the task's person on a member's task, or an owner, and the payer follows
  `qorpera_starter_sponsor`. When `from` is not active, the Co-Founder is woken, and may hand the task
  to another agent (§2);
- the markers (which commit or `due` was woken) live in a runtime table of H2c; a wake that cannot be
  made is skipped and tried again on the next scan, never failing the scan.

**What H2b without H2c means.** Q1's H2 row is met except the wakes, which wait for C4. Until then no
member can write a task (no member writer before C4, no link service before H5), so no `done` or
`declined` can happen, and nobody misses its wake. Tasks agents create can pass their `due` with no
overdue wake. No member writer of folder-v2 files (H3's web, F3's desktop) may go live before H2c, or a
`done` would wake nobody. Q1's step table shows H2c waiting for C4.

**Three PRs, stacked on H1b:**
- **H2a, TS:** the seed tree and seeded paths (with the TS comparison list), the skill text, the proof
  file names, and the writers' shared helper for the person's change (tick, done, declined).
- **H2b, SQL:** the two index tables, apply and verify, the rules of §1–§4, the lock targets of §6
  (with `qorpera_folder_structured_lock`), and the seeded list, in one migration; SQL test 803, a race
  test (805), and 785 updated to H2's rules.
- **H2c, wakes:** after C4's listener exists, against its interface (§9).
H2a and H2b do not depend on each other (`companyStateSeedTree` is used only by tests today), so their
order is free.

**Questions before building:**
- F1 (the coordinator decides while F1 is idle): H2c's interface (§9), proposed in the H2 PR body.
- Q1: the person never acting as the company on their own task (§1); `due` in the future when set (§2);
  deleting only final tasks (§2, §4); H2c waiting for C4 in the step table.
- A1: references are no longer re-checked on the person's change, so a disconnected account never
  blocks a takeover task's `done` (§3); the platform never creates a task, so a takeover task is written
  by the agent's own run (§1).

**Built (H2a): the TS side** (`packages/cloud-client/src/company-state-files.ts`), as planned:
- `companyStateSeedTree` seeds `human-tasks/`, `contacts/` and `skills/human-task/SKILL.md`, in contract
  5.6's order; `COMPANY_STATE_SEEDED_PATHS` names the two folders (H2b gives SQL the same list).
- `COMPANY_STATE_HUMAN_TASK_SKILL`: Q1's "how agents write a good task", with the file's keys and how to
  follow a task up. It describes the wakes of H2c as they will be.
- `humanTaskFolder`, `humanTaskProofPath` (`proof/<kind>-<n>.<ext>`, lowercase extension) and
  `humanTaskNotePath`.
- `humanTaskPersonChange(path, text, change)`: a tick flips one step's box on its own line and nothing
  else; `done` sets the status and removes `reason`; `declined` sets both; only on an open or returned
  task, and only when the result parses. The web (H3) and the link service (H5) use it, so the person's
  change is the same bytes everywhere.

**Built (H2b): the database** (migration 20260928429986, SQL test 803; test 785 updated), as planned, with these
choices made while building:
- The two tables carry `folder_key` beside `folder_path`, indexed with the environment (not unique), so the rules find
  a task by its file's key without folding every row.
- One function checks the paths of every unit first (`qorpera_company_state_task_paths`): what leaves (a delete's or
  move's source) and what lands (a write, mkdir, new folder and its contents, a move's or copy's target). A misnamed
  folder is left to the name check, which says what is wrong with it. Nothing moves or copies onto `human-tasks`
  itself: it is made with a mkdir.
- `qorpera_company_state_human_task_rules` reads the task's last file through its index row (a restore compares with
  it); `qorpera_company_state_task_references` checks a reference only when the save sets or changes it, and `todo`
  whenever `todo` or `from` changes; `qorpera_company_state_contact_rules` keeps one file per contact and its email
  while a task that is not final names it.
- The rank-5 targets come from `qorpera_company_state_task_targets`; `qorpera_folder_structured_lock` locks the two
  tables by `environment_id:id`, after the routines. A row last written by a commit whose `seq` is past this commit's
  `as_of_seq` (`qorpera_company_state_changed_since`) answers `version_changed`, which the commit reports as a
  conflict.
- `started_by_user_id` is the creating commit's requester when it is a member: the member themselves, or the member a
  run works for. The platform never creates a task, so it is never null for a task made after H2. Later saves never
  change it.
- A final task's folder is removed whole (not file by file); a task file is renamed or removed by the company's side
  only (never by its person, never by the platform on a member's task).
- The proof check reads the proof folder's children through the entries' children index.
- A move that leaves a task's or contact's row without its moved entry stops the commit (XX000), as for the other
  kinds; a second run of the migration stops before it changes anything.
- SQL test 805 races two sessions: a proof unit behind the person's done meets a conflict, and a contact's delete
  behind a new task naming it is refused; without the rank-5 locks both would save.
- 785 now hires its asking agent, uses a due date in 2099, makes a task's folder as its person after the task, and
  expects H2's answers where they come first (the seeded root, a task with a folder keeping its name, the person's
  rule); its secret cases use new ids, so H1's rule still answers them and names `secret_state`.
- 65 distinct mutants of the migration, mine and the code review's (each path, person, company, reference, contact,
  lock, index, verify, proof and seeding rule): 64 caught by 803, 785 or 805, and one equivalent (it rewrote the
  final-task check into the same rule).

**Then:** H2 (on the folder core) adds what §2 lists under "What H1 does not decide"; H3 the web
screens; H4 the emails; H5 the contact links, after F2 widens erasure. A1's takeover becomes a
human task through `from`, `connection`, `step` and the secret keys, once H2 is in.

**Plan (A1-7): website accounts in connection files** (A1's request of 2 October; A1 keeps the
vault records, #653). The keys and statuses of §2's `connections/` table for `service: website`.
Two PRs, in this order:
- **A1-7a, the parser:** `site`, `two_step` and `opened_for`, required or refused by service; the
  statuses `pending` and `needs_person` for a website account only; `writeConnectionFile` writes
  them. Another connection's parse keeps its exact shape, so the rule that a member may change
  only the text below the settings (which compares the settings with the saved version's) keeps
  working on every file saved before.
- **A1-7b, the database** (migration 20260928439950, SQL test 801):
  `qorpera_company_state_parse_problems` checks the connection parse per service, with the
  vault's host rule. Nothing else changes: the platform's save still needs the vault row active
  with the connector `website`.
- Then A1's vault writer writes website account files. Before it, no file has these keys.

**Built (A1-7):** as planned. A1-7b patches two anchors in `qorpera_company_state_parse_problems` (marker
`20260929999950` in its body) and repeats the vault's host regex rather than calling
`qorpera_company_account_host_valid`, so it does not wait for A1's migration: labels of 1–63 characters, as A1
tightened the vault's rule on 2 October. It applies before or after H1b's migration (20260929999000): their anchors
do not overlap. SQL test 801 (on 704's fixture): the platform saves a website file in each of its four states, a
member changes only its text (and an old gmail file's text, whose shape is unchanged), the shapes, and which rule
each refusal names; 13 of 13 mutants caught (the review's two survivors included).

**Built (P22a, the vault's due marks; migration `20260930006000`, SQL tests 852 and 853):** the coordinator approved
on 3 October that the vault never commits a file itself (core §3 step 4 and C4 amended): it marks, and the object
gateway's writer (P22b, behind its own flag) converges. Triggers on `qorpera_cloud_secrets`,
`qorpera_cloud_secret_operation_grants` and `qorpera_company_accounts` insert a mark (a plain insert with a generated
key and the company row's foreign key, which every vault change on folder-v2 already holds `KEY SHARE`: no wait, no
cycle) for a company-owned connection of a folder-v2 environment, only when a field its file shows changed. The writers'
table `qorpera_folder_connection_file_work` keeps one row per connection (so each claim's generation, and its operation
key, is new); the claim creates rows in secret order, takes one due row `SKIP LOCKED`, consumes the marks it sees (a
mark that commits later keeps the connection due), and answers `qorpera.connection-file-claim/v1`: the generation, the
operation key, `present`, the allow-listed `settings`, the new file's `path`, and `current` (the indexed file's path,
version and hashes). The finish closes the claim for the current generation's writer only, or backs it off with a
problem code (2^attempts seconds, at most ten minutes). Review round 1 added: the claim takes the companies' key share
and the marks it consumes SKIP LOCKED, so a purge (company row, marks, then work rows) never deadlocks with it and a
company held for deletion never stalls other companies' claims; files only for catalog connectors and website accounts
(`qorpera_folder_connection_has_file`); `actions` only for unexpired grants; and `qorpera_mark_connection_files`. 852:
each mark and non-mark, the claims' state, the platform commits (write, the member's text kept, a stale version,
delete), leases, names, website and agent accounts, back-off bounds, expiries, and that nothing outside the allow-list
leaves; 853: the races (out-of-order marks, two writers, a vault change during a claim, a purge, a company held for
deletion).

**Built (P22b, the writer; object gateway, off unless `QORPERA_CONNECTION_FILE_WRITER=1`):** `connection-files.ts`
claims up to ten due connections every 15 s in a loop of its own (one drain at a time, 60 s each, its own database
client, so the gateway's other maintenance never waits for it) and refuses, unread, a claim carrying any field outside the
allow-list (finished `claim_invalid`). A new file is the canonical writer's; an existing one keeps every byte but the
settings that changed; a file the parser refuses keeps its text below the settings. It stages the bytes as the platform
in the gateway's own store, commits one unit with the claim's operation key and the version it read (`:2`, `:3` … and
`-2`, `-3` … names when a new file's name is taken), deletes the file of a revoked or closed account, and finishes with
a code on any problem (`version_changed`, `lock_conflict`, `unavailable`, …). The staging, reading and committing as
the platform live in `platform-folder-writer.ts`, which F2's company creation (P14b) shares.
`scripts/test-object-gateway-connection-files.mjs` (hosted-db step) runs it on a real database: 704's company, the
first files, a member's text kept through a rewrite, a Disconnect's delete, and nothing outside the allow-list in any
file version or writer commit.

**Plan (F2-5b): worker briefs and results on the folder core** (core C3; the coordinator's slice P21 of
2 October). Revised after design review r1 and the coordinator's answers of 3 October.

In short:
- **What a member sees:** each worker has two files in its todo's folder, `brief.md` (what it was asked
  to do) and `results.md` (what it reported, and the agent's decision).
- **Who writes them:** only the worker tools (`manage_worker`, `report_work`). Not the model's file tools,
  and not a member. A restore of a deleted agent brings them back as they were.
- **What waits:** coding workers on `folder-v2` (their machines come with C1c-3h and 3i; their dispatch
  refuses `0A000` until then), and the wakes that start and revive workers, which run once C4's
  `folder-v2` materializer (P28) calls the worker drain.

What exists (inventory of 3 October, master 041ad1c15):
- A worker is a row, `qorpera_runtime_workers`, with its follow-ups in `qorpera_runtime_worker_events`. The
  row holds the brief (`dispatch`), the result, the decision and the runtime state (state, sequence, epoch,
  the wake, revival). Nothing writes `brief.md` or `results.md` today.
- Every worker writer (`qorpera_manage_agent_worker`, `qorpera_report_worker_result`) goes through the
  old actor, which refuses `folder-v2` (55000). `manage_worker` is still offered to `folder-v2` runs.
- The worker drain (dispatch failures, revival) and the wake materializer skip `folder-v2` companies,
  until C4 gives `folder-v2` real runs (P28).
- The hook knows the two kinds by path and checks their names, and nothing else: anyone who may write
  the agent's folder can save a `brief.md`, and a worker folder can be deleted or moved under a running
  worker.
- F2-5a refuses `done` on a todo while a worker is active, but nothing locks the todo row, so a dispatch
  can race it.
- A commit carries a run's review (rank 7b) and receipt (after rank 9) only when the run is its actor. A
  `platform {}` commit carries neither, and skips the pause check and the review.

**1. The files.**
- `brief.md` settings: `id`, `title`, `species`, `access`, `revival`, `dispatched_at`, and (new)
  `follow_ups`, the number of follow-ups (0 at dispatch), with `followed_up_at` when it is 1 or more.
- `brief.md` body: sections in this order, each a line that is exactly the heading, then its text:
  `## Goal`, `## Done when`, `## Context` (when there is context), `## Sources` (when there are sources:
  one `- <path>` item per folder path), `## Authority`, `## Output`, `## Cancellation`, `## Completion`, and
  `## Follow-up` (the latest follow-up only, when `follow_ups` is 1 or more). Earlier follow-ups stay in
  the file's history and in the events table, as today, where the row holds only the latest. No new
  limit: today's bounds (goal 4000 bytes, done 2000, context 4000, eight sources of 512, a follow-up 4000)
  fit within the 32 KiB body.
- `results.md` settings as §2 (`outcome`, `reported_at`, `decision`, `note`). Body: the summary (up to
  4000 bytes), then `## Needs` (up to 1000 bytes) exactly when the outcome is `blocked`, then `## Files`
  when it lists any: up to four `- <path>` items, as today's report.
- The parser reads only those headings, in that order, as section starts; any other line is text. The
  writers refuse model text (a goal, a summary, a follow-up) that holds a line equal to one of these
  headings, and their output round-trips through the parser.
- The parse: the brief gives `goal`, `doneWhen`, `context`, `sources`, `authority`, `output`,
  `cancellation`, `completion`, `followUps` and `followUp`; the results give `summary`, `needs` and
  `files`. From these the index builds today's `dispatch` and `result` shapes, so the worker's wake keeps
  its closed shape apart from its paths.
- On `folder-v2` a worker key follows the folder naming rule (§1 "Names"), stricter than today's key rule
  (no `.`, `_` or `--`), and is not a reserved name: the worker's folder is named by its key. The tools
  check both before the receipt.

**2. Who writes them** (contract 13: "The platform writes the brief when the worker is dispatched and the
results when it reports … including coding workers, whose view of `agents/` is read-only").
- **The reading** (the coordinator, 3 October; no contract text changes): "the platform writes" means a
  platform worker tool commits the file, as the run, with the tool's request, receipt and review inside
  the commit. The history then shows which run dispatched or reported. A `platform {}` commit is not
  used, because it cannot carry the receipt and the review, and it skips the pause check.
- **The entry:** `qorpera_folder_worker_commit(environment, actor, operationKey, units, request, receipt,
  review)` (the service role and the native host). It refuses any actor but `run`, and refuses when a
  request is already set in the transaction. It sets the transaction-local setting
  `qorpera.folder_worker` to the request with the environment, the run id and the operation key, calls
  `qorpera_folder_commit`, and clears the setting. The hook refuses a setting that does not name its own
  commit's environment, run and operation key.
- **The hook's guard:**
  - `brief.md` and `results.md` are written or deleted only with a carried request that names them.
  - A worker's folder (any folder directly in a todo's folder) is made only by a carried dispatch.
  - Every other file inside a worker's folder is ordinary and follows folder authority: a write worker's
    outputs.
  - A commit that carries a request holds only the units its action names.
  - Without a request, a worker's folder moves only with its whole agent folder (its row is repointed),
    and is deleted only by a delete of a folder that holds it (the worker's folder, its todo's folder, the
    todos folder or the agent's folder), which retires the worker's row. Both only while none of those
    workers is active.
  - A restore of a folder that holds retired workers (an agent's folder, as contract 5.6 lets a deleted
    agent come back, or a todo's, the todos folder or a worker's own) brings each one's `brief.md` and
    `results.md` back only at the last versions its row records, byte for byte, and the row back
    finished, never active; the row then points at the new versions, which the check step verifies.
    Whoever may restore that folder may do it, and the restore's own review class applies; the worker
    files add none. Any other restore of them is refused.
- **Authority:** dispatch, follow-up and decide follow folder authority (the run acts for its requester,
  as W1 does). A carried report by the worker's own run passes the authority check (the read-only
  worker's ban included, `qorpera_folder_actor_resource_allowed`), so a narrowed folder or a read-only
  view never stops a report; the hook then allows only that worker's own `results.md`. This is the only
  exception, and only through `report_work`.

**3. The actions** (the units, then the hook's rules from the carried request and the locked rows).
- **`dispatch`**, by the todo owner's own company run, never a worker's: the todo's folder (`mkdir`, when
  it is missing), then `new_folder <todo>/<worker>` holding `brief.md`.
  - The todo is open or blocked, and not retired. The worker key is free in that todo. The brief's `id` is
    new; the runtime derives it from the run and the operation key, as hiring does.
  - The brief agrees with the request: title, access, revival, `in-house`, goal, done, context, sources;
    the standing texts equal the platform's own (SQL writes them today and keeps them); `follow_ups` is 0;
    `dispatched_at` is within five minutes of the commit.
  - Each source is readable by the run (`qorpera_folder_actor_allowed`, read) and passes the path rule.
  - The member who started the chain pays for background work (today's check).
  - Review: delegation, with an answered review always (R1). A worker unit that would wait for review is
    refused, never parked.
- **`followup`**, by the same agent's company run: `write brief.md` at its version with `follow_ups` one
  more, `followed_up_at` within five minutes of the commit, `## Follow-up` the new text and everything else
  unchanged; and `delete results.md` at its version when it exists.
  - The todo is open or blocked; the worker is not active; an in-house worker that was cancelled cannot
    continue; the starter pays (today's checks). Review: delegation.
- **`report`**, by the worker's own run (its wake's worker, at the worker's current sequence): `write
  results.md` while the worker is active, with an outcome other than `cancelled`, no decision, and
  `reported_at` within five minutes of the commit. Each listed file has a version written by a commit of
  this run (today: a revision this run wrote). Plain.
- **`decide`**, by the agent's company run: `write results.md` at its version with only `decision` and
  `note` changed; `accepted` only when the outcome is `succeeded`. Plain. Without a report there is no
  `results.md`, so `decide` refuses: a worker that failed or was cancelled without reporting is not
  decided on (today a reject of such a worker only suppressed its completion).
- **`cancel`**: no file. A run effect like a coworker message: `qorpera_folder_tool_run` with the todo
  (`FOR SHARE`) and the worker (`FOR NO KEY UPDATE`) at rank 5, then the receipt, then today's cancel on
  the row (its queued wake cancelled), without touching the todo row.
- **`status`**: a plain read of the rows, as W1's todo list. It reads no file.
- **`archive`** is for coding sessions, and refuses on `folder-v2` with them.

**3a. A todo's file and its folder** (as H2 keeps a task's file and folder). A todo's file is moved or
deleted only when its folder holds no worker's folder, so a todo with workers is never renamed (its
workers' folders could not follow: a change set is not atomic). To delete it, delete its folder first (an
earlier unit of the same change set, or an earlier save), which retires its finished workers; never while
one of its workers is active. A refused rename says so: "this todo has workers: write a new todo, or delete
its folder first".

**4. The index.** The row stays the worker's index and keeps its runtime state. On `folder-v2` the hook
writes it in the same transaction as the files:
- dispatch: the row (id from the brief, `dispatch` built from the parse, `occurrence_id` empty), the
  `dispatched` event;
- followup: as today's follow-up (sequence, `active`, result and decision cleared, completion reset,
  `occurrence_id` empty, `steering_run_id` the follow-up's run, `dispatch` from the new parse), the event;
- report: the state, `result` built from the parse with the run and the sequence, `reported_at` from the
  commit's clock, `completion_state = waiting`, the event;
- decide: the acceptance columns, a waiting completion suppressed, the event.
- The todo's revision is not bumped (it is moot for folder rows, §4).
- New columns, as the roster's: `folder_environment_id`, `folder_path` and `folder_key` (the worker's
  folder), `folder_brief_version`, `folder_results_version` (empty exactly when there is no
  `results.md`), `folder_commit_id` and `folder_retired_at`. `sequence` equals `follow_ups + 1`, checked.
- A retired row keeps its history, runs that reference it keep working, and a waiting completion still
  revives its parent. A rebuild keeps the runtime columns (`steering_run_id`, `requested_by_user_id`, the
  wake and completion), as H2's `started_by_user_id`.
- `result` is partly a copy and partly runtime state: a copy of `results.md` when the worker reported; the
  platform's outcome (cancelled, ended or never started without a report, a stopped parent, a cancelled
  todo) otherwise, with no file. C2's queue may later write `results.md` for those; the parser keeps
  `cancelled` for that.

**5. Locks.** Rank 5 gains two tables, after `qorpera_cloud_routines` and before
`qorpera_folder_human_task_index`: `qorpera_runtime_agent_todos`, then `qorpera_runtime_workers`, by id.
- Every unit that writes, moves or deletes an existing todo file takes that todo `FOR NO KEY UPDATE`; so
  does every unit that moves or deletes a folder holding todos (from its `asOfSeq` listing).
- A worker commit takes its todo `FOR SHARE` (so `done` and a dispatch wait for each other, and two
  reports in one todo do not) and its worker `FOR NO KEY UPDATE` (a new worker's id is claimed), with the
  company row `KEY SHARE` at rank 0.
- A unit that moves, deletes or restores a folder holding workers takes them `FOR NO KEY UPDATE`, and their
  todos as a todo write does.
- `decide` answers `version_changed` when a todo or worker row it reads was written after the commit's
  `as_of_seq` and it did not lock it (H2b's guard).
- This patches F2-6's targets for todos, with a body marker. No company-wide lock, and no lock outside
  rank 5.

**6. Wakes: the folder-v2 worker drain** (F2 builds it, the coordinator agreed 3 October). The commit
inserts no wake: the hook has no call at core §3 step 10, and a refused wake must never roll back the
files. So a dispatch or a follow-up leaves its row active with no occurrence, and the drain starts it.
- The drain is the shared folder drains' `workers` (LISTENER.md §9; F2-5b-3, migration 20260930003100), first in the
  orchestrator's pass, before the listener and the materializer.
- `qorpera_folder_workers_company(environment, limit ≤ 32)`: one company in its own transaction (never inside a
  caller's transaction that holds admission), at read committed, answering `{state: done | idle | paused | busy |
  deleting | not_folder, started, failed, cancelled, revivals, suppressed, undeliverable, skipped}`. In order:
  1. `qorpera_folder_company_enter(environment, profile, targets, false)`, then the pause and the deletion read
     again under the fence (answers, never 55000): the fence `KEY SHARE`, the company row at rank 0, and the
     targets at their ranks: each requester's member row (rank 1, `KEY SHARE`), each parent agent's staff row (rank
     2, `KEY SHARE`) and execution authority (rank 3, `KEY SHARE`), then the todos (`FOR SHARE`) and the workers
     (`FOR UPDATE`, so a row the drain updates inside a block is never key-shared by another) at rank 5. The workers
     are the due ones and up to four waiting workers of each waiting one's parent, so a revival's set is always among
     the locked rows; a lock it waits on past 2 seconds answers `busy`;
  2. the parent's conversation `KEY SHARE`, for a completion wake (as routine firing holds its session);
  3. `qorpera_folder_admit_wakes`;
  4. one block per worker: the dispatch wake of a row with none; a dispatch wake that is refused,
     cancelled at insert, or fails with an error (42501 when nobody pays, 55000) makes the worker `failed`
     (`not_started`, completion `waiting`), so it never stays active without a wake; a worker that ended
     without a report becomes `failed`; a stopped parent cancels its workers; a cancelled todo cancels its
     workers (`todo_cancelled`, which no queue does yet), each cancel taking the worker's queued wake `NOWAIT` (one
     P28's materializer holds keeps the worker for the next pass); and revival with today's rules (`each`, `batch`,
     at most four results, one revival of a parent at a time). A revival block that fails (42501, P0002,
     55000), or whose wake is cancelled at insert, marks its workers undeliverable. An erased worker's waiting
     results are suppressed (their text is gone). Coding workers are started by their coding turns and only
     revived here. The drain never touches a todo row. A pass handles at most 32 due workers, within core §3's 64
     subtransactions.
  - The parent's job status is a plain read: no lock, no `NOWAIT`, nothing taken before the fence. The drain
    acts only on final job states, which never go back, so a stale read waits one pass.
  - The legacy `qorpera_serialize_wake_admission` (the company row `FOR UPDATE NOWAIT`) is never used.
- `qorpera_folder_workers_due(after, limit)` lists, a page at a time, the folder-v2 environments with a due worker
  (`qorpera_folder_worker_due`, the same predicate the drain uses, so it leaves out companies the drain would only
  answer `idle` for), leaving out paused companies and those being deleted.
- **The seam** (core §11 C4, corrected 3 October): the orchestrator's shared folder-drains step runs the drain for
  each company the due list names, in its own request, before the materializer's list, so a worker started or a
  parent revived this pass is materialized this pass; the edge function's `FOLDER_DRAINS` and the orchestrator's
  `CLOUD_FOLDER_DRAINS` name it `workers`.

**7. The runtime.**
- `manage_worker` on `folder-v2`: dispatch, follow-up and decide build the files with the shared writers,
  stage them, and commit through the entry under the call's receipt and, for dispatch and follow-up, the
  automatic review's record (R1 accepts `manage_worker` for those two actions only). Cancel and status call
  their functions.
- `report_work` on `folder-v2` writes `results.md` the same way, under the worker run's receipt.
- The wake shapes gain `folder-v2` paths: the output folder is the worker's folder, and the todo path is
  the todo file. A write worker still writes where its agent may (the brief's authority text).
- The new entry and status join the native host's call list (`qorpera_native_host_calls`) with scope
  `folder` (run actors only; their signatures take the environment and the actor), and cancel with scope
  `binding`. All three join the runtime client's RPC lists (test 760's pinned shapes) and its
  `NATIVE_HOST_CALLS` in F2-5b-4.
- A retired worker row keeps the folder key it had: a worker's folder deleted before its agent's folder is
  renamed comes back only at its old path.

**PRs, in this order** (each with an exact-head review and node 2 `changed`):
- **F2-5b-1, the parser** (`packages/cloud-client`, no SQL): the sections, the parses, the writers with
  their refusals, `appendWorkerFollowUp`, the key rule. Live on every writer before F2-5b-2.
- **F2-5b-2, the database** (migration 20260930003000, SQL tests 840 and 841): the hook (shape, rules, guard, index, locks), the
  entry, cancel, status, the authority exception, the new columns, R1's tool, the native-host list. Body
  markers in every patched function, anchored on today's text (H2b's included). New functions for the
  `folder-v2` payloads; the shared payload functions and the legacy drain stay untouched.
- **F2-5b-3, the drain** (migration 20260930003100, SQL tests 842 and 843): §6.
- **F2-5b-4, the runtime** (TS): §7.

Tests: every action's rules and refusals; a worker-file unit with no request (a member, the model's file
tool); a request that names another run, environment or operation key; a report commit holding any other
unit; the read-only and narrowed-folder report; R1 accepting `manage_worker` for dispatch and follow-up
only; races of dispatch against `done`, two saves of one todo, the drain against cancel, a report and a
subtree delete, and an agent folder move against a dispatch; a mutant run, as H1b and H2b; and the legacy
worker suites (379, 385, 387, 388, 395–399, 600–606, 656) after the new columns.

**Plan (P16): interfaces and tables on the folder core** (the coordinator's slice P16, RUNTIME-INTERFACES.md
step I6, with Interfaces; design, 3 October, review r1 folded). The rules are RUNTIME-INTERFACES.md §6.1 (its nine
checks, as #751 states them) and §7 for review. Interfaces' TS side is #751: `parseInterfaceStateFile`, the parse
types, the fixtures `interface-state.json` and `table-rows-typed.json`, and `interfaceLibraryFiles`. This plan says how
the hook runs them. Folder-v2 only (the founder decision of 3 October): no snapshot-v1 branches and no pins of old
function text.

*The kinds.* `qorpera_structured_path_kind` names four new kinds by the path's shape alone, whatever the name:
`interfaces/order.md` (`interface-order`), `interfaces/*/interface.toml` (`interface`), `tables/*/table.toml`
(`table`) and `tables/*/rows.csv` (`table-rows`). So a badly named folder's file is still checked, and refused. The
shared helpers learn them too:
- `qorpera_company_state_path_problems` checks the folder's name at position 2 for the three kinds in a named folder,
  and exempts all four from the `.md` rule;
- `qorpera_structured_folder_names` names the places: `interfaces` and `tables` (no name of their own),
  `interfaces/<name>` and `tables/<name>`;
- `qorpera_company_state_carried` adds `interfaces` and `tables` to its roots, so a folder copied or moved into, within
  or out of them is checked entry by entry (`kind_change`, `structured_copy`): a table or an interface is never
  copied as a folder, and a folder holding a file named `table.toml` never becomes a table by moving;
- `qorpera_company_state_checked` runs the shape check for the four kinds.

In P16b, `companyStatePath` (the TS twin of the path kind) learns the four kinds and exempts them from the `.md`
rule, and `parseCompanyStateFile` dispatches them to `parseInterfaceStateFile`. Writers decide what to send with
`companyStatePath`, so only then do the runtime's tools, the web, the object gateway (the creation worker and member
writes) and the folder service send them as structured entries. The runtime ships through the release train.

*Coding sessions* see `interfaces/` and table definitions read-only (contract 5.6, RUNTIME-INTERFACES.md §7).
`qorpera_folder_coding_protected` adds `interfaces`, everything under it, and `tables/<name>/table.toml`. The
callers already check each key of a new folder, a delete and a move, so a coding session never creates, moves or
deletes a table folder either; it writes `rows.csv` under `[write]` and the rules below.

*(1) The parse's shape* (`qorpera_company_state_parse_problems`; §6.1 rule 1). A parse it refuses is
`structured_invalid` with the state files' `value` problem (the parser's own codes come from the client):
- **Full** for `table` (closed keys; a lowercase strict uuid `id`; the name and texts with the parser's bounds; 1–40
  columns with their types and the keys each type takes; a key of 1–3 columns, each once, never optional and never a
  number; `holder`, `time` and `[write]`), `table-rows` (§6.1 rule 1's bounds: 1–40 header names, rows of
  `{line, fields}` with `line` at least 2 and strictly increasing, fields as wide as the header, at most 32,768 rows
  and 65,536 bytes of fields) and `interface-order` (unique strict uuids).
- **Shallow** for `interface`: closed top-level keys, and typed `kind`, `id`, `name`, `main` and `access` (an object of
  exactly `members`, `agents` and `edit`, each with its parser's values). The fields review reads are typed too: `buttons` is an array of objects
  with a string `id`, and `views` an array of objects whose `blocks` is an array of objects whose `buttons` is an array
  of strings. The rest by JSON type and size. Three conditions keep this safe (Interfaces):
  - readers (I7's web, I8's `interface_read`) parse the text themselves and never trust the stored parse, so the
    parser-only refusals (`outside_value` included) hold even against a client that lies;
  - `main` from the parse is rule 3's only input, and the web handles zero or two mains in the texts it reads;
  - a later slice that indexes or reads a field adds that field's full check.

  A stored parse that is missing (a file saved as an ordinary file before P16 in an operator's company) reads as
  absent: an interface that is not main and open to anyone, a table with no definition (its rows are refused until
  `table.toml` is saved again).

*(2)-(9) The save check*, against the parses as they are when the unit is decided (earlier units of the change set
applied). Placement and the owners rule run for every unit, structured or not (`structured_rule` with §6.1's codes):
- **Placement** (rule 2): every path a unit lands, a moved folder's descendants included, is one §6.1 allows: under
  `interfaces/` only `order.md` and one folder per interface holding `interface.toml` and `README.md`; under `tables/`
  one folder per table holding `table.toml`, `rows.csv` and `README.md` (written `README.md` or `readme.md`). So a file
  `tables/foo` is refused and a folder `tables/foo` allowed. `interfaces/`, `interfaces/order.md`, `tables/`,
  `tables/areas/`, its `table.toml` and its `rows.csv` join the seeded paths, never deleted or moved. So do the main
  interface's folder and `interface.toml`, while it is main. A table's two files go or move only with their folder,
  and a `rows.csv` needs a `table.toml` in its folder: stored, or in the same unit.
- **Main** (rule 3): a unit whose `interface.toml` has `main = true` is refused while another live one has it (so,
  during a double main, saves that keep `main = false` still pass). A change set is not atomic and a refusal is per
  unit, so this is §6.1's per-unit rule (#751): a switch is two units, the old main set to
  false first, then the new one to true, and `save_interface` and the web send them so; the seed has exactly one main
  (Pulse). What this gives up, recorded with Interfaces' yes:
  - zero mains can last: a demotion with no promotion after it leaves none until someone saves one;
  - contract 5.6's "the main interface can be changed but not deleted" holds while it is main: an interface is
    demoted, then deleted (put to Jonas through the coordinator, since the contract governs);
  - **no lock** serializes two promotions. Rule 3 reads the stored mains, and two units that each make a different
    interface main, decided at the same time while there is none, both pass. This takes no new company-wide lock (the
    rule of 27 September), at the price of a rare double main, which the web shows (I7) and which the next save of
    either main resolves: it is refused until one is set to false. A lock on the company's index row would serialize
    them, but every vision save would then have to take it too, before its paths (a deadlock otherwise: a vision save
    updates that row in apply).
- **Owners** (rule 4): while an interface's stored parse has `access.edit = "owners"`, only an owner or admin (or the
  platform) changes, moves or deletes anything in its folder, or lands anything in it. An agent never does. Creating
  an interface with `edit = "owners"` is open to anyone who may create one (Interfaces), and a copy out of one only
  reads it. Like rule 3, the rule reads the stored parse without a lock: a contributor's save can land at the moment
  an owner's change to `edit = "owners"` commits.
- **Write** (rule 5): a `rows.csv` save under the stored definition's `[write]`. The platform passes. A table's first
  rows, in the unit that brings its definition, are its maker's (beyond #751's rule 5, which reads a stored
  definition; asked of Interfaces).
- **Rows** (rule 6): the port of `parseTableRows`, set-based SQL (no loop per field or row). The header against the
  definition (a header that fails refuses the file at line 1); each field by its column type with §6.1's patterns and
  bounds (a time in its canonical text; years 0100–9999); one `row` problem per row, for the first column in the
  definition's order that fails; the key as a JSON array; a later row with an earlier key is `duplicate`; at most 50
  problems, then "and K more problems". The definition is the one the same unit brings, else the stored one.
- **Definition change** (rule 7), on a `table.toml` save while its folder holds rows (stored, and not replaced in the
  same unit): the stored rows fit the new definition by rule 6, and a `needs_yes` column gains or loses its flag, or
  goes, only while every row leaves it empty (`claim`).
- **Claim** (rule 8), on a `rows.csv` save: the stored rows against the new ones by key, typed by the definition at
  commit; a cell changes when its value's JSON text differs. *Self* is the member. An agent has no self until I9b,
  so it changes no claimed cell, and accept never passes until offers exist. The platform passes only changes that
  clear a cell (a leaving member's cells, contract 5.6); seeding writes header-only rows. A new table's rows have no
  stored rows, so each claimed cell they set must be a take: the maker's own id.
- **Areas** (rule 9): `tables/areas/table.toml` keeps its three columns, and after a rows save no agent is in two
  areas.
- **Ids:** one live interface per `id`, and one live table per `id` (`duplicate`); a table folder keeps its id
  (a save that changes it is `duplicate`, as #751's §6.1 says), since its index row is keyed by it. An interface has no index before I7, so it may take a new id.
  The interface check takes no lock: two interfaces made at the same time with one id can both land (I7 shows it).
  Two tables made at the same time with one id both pass decide, and the second commit fails whole on the index
  row's key, as H2's index does.

*The index and the locks.* No index is read before I7, but the rules read a table's definition when its rows change,
and its rows when its definition changes, and their path locks don't conflict (each holds `tables/<t>` KEY SHARE and
its own file FOR UPDATE). So P16 adds `qorpera_folder_table_index`, one row per table folder, keyed
`(environment_id, id)` by the table's id as H2's index is: the folder's path and key, the definition's and the rows'
versions (rows null while there is no `rows.csv`), the commit, and retired. No foreign key to `qorpera_profiles` (its
KEY SHARE would come in apply), and a key index that is not unique. It holds only pointers, rebuilt from the files.
- **The lock**, FOR NO KEY UPDATE at rank 5, after the contact index in the table order, on: every write of
  `table.toml` (by its parse's id) or `rows.csv` (by its folder's live row), a new folder holding them, and a delete or
  move at or above a table folder (never the seeded `tables` root, which is refused anyway).
- **The window:** a row created after this commit read its targets is locked by nobody. So a save finding a table row
  changed by a commit after this one's `as_of_seq` answers `version_changed`, H2's guard: the caller reads again. A
  delete or move of a table folder does the same for every live table row at or under its source, so apply never
  repoints or retires a row it did not lock.
- **Apply** writes the row: a first `table.toml` inserts it (a retired row of that id is reused), a save moves its
  versions, a move repoints every row at or under the source to its new path and versions (counting them, and raising
  on a mismatch, as H2 and F2-5b do), and a delete retires them. **Verify** checks every row the commit wrote: its
  definition version is its `table.toml` entry's, its rows version is null exactly when there is no `rows.csv` entry
  and otherwise that entry's, and its path is the entry's spelling.

There is no new company-wide lock. The core's rank-5 list (core §3 step 4) and its kinds list (core §5) are updated.

*Review* (§7). `qorpera_folder_structured_review_class` returns `delegation` for an agent's change that:
- creates an interface (no stored parse at its path);
- changes `$.buttons`, or names under `$.views[*].blocks[*].buttons[*]` a button its stored parse names nowhere
  there (a set, so reordering blocks stays plain);
- changes `$.access`;
- creates a table, or changes its `$.columns` or `$.write`.

Anything else is plain, and an agent's delete or move is the core's deletion class before the hook is asked. The
review recorder (C2 R1) gains `save_interface` as a delegation, only for change sets whose every unit is at or under
`interfaces/` or `tables/`. An agent's delete of a page or table (`destructive`) goes through `company_delete`; I8
decides whether `save_interface` also records deletions. A delegation-class change through the mount or a shell has no review, so the commit denies it, as §7 says.

*Cost.* A `rows.csv` parse is stored with its version and sent with its request: at 64 KiB of CSV it is up to about
1 MB. 865 times the worst case (64 KiB of rows against a 40-column definition, a definition change over them, and the
claim rule over every row) against the core's 4-second tool bound, and reports the stored parse's bytes for the
largest and the smallest-row 64 KiB files, the growth each saved version adds.

*The seed.* `companyStateSeedTree` adds `interfaceLibraryFiles(newId)`: `interfaces/` with Pulse, Mailbox, Members
and `order.md`, and `tables/` with `numbers`, `areas` and `cards` (header-only rows). The SQL seeded list and
`COMPANY_STATE_SEEDED_PATHS` gain the protected paths. The creation worker's `creationUnits` (P14b) makes each
interface folder and each table folder one `new_folder` unit, with media types by extension (`text/markdown` for
`.md`, `text/plain` for `.toml` and `.csv`). Its ids are random on each attempt: a creation commits whole, and a
completed one answers from its row.

*Hand-overs.* P18b's erasure under `tables/` deletes retired table rows at rank 5, in the lock function's table
order. I9b: when an agent gets a self (its area's supervisor), its rows save reads `tables/areas` and must lock the
areas row in the same rank-5 pass; offers will need their own lock.

*PRs, in this order:*
- **P16a, the database** (migration 20260930016000), with SQL tests:
  - 864: the kinds, shapes (the fixtures' valid parses, embedded), placement (copy and move into and within the
    roots), coding sessions, main, owners, ids and review classes;
  - 865: write, rows (the typed fixture), definition changes, claim (the platform clearing a cell), areas, a
    creation-shaped new folder, and the worst-case timing;
  - 866: races: a rows save against a definition change, the window above, a table move or delete against a rows
    save, and two promotions;

  and a mutant run, as H2b and F2-5b. P16b adds a check that 864's embedded parses equal the fixtures.
- **P16b, the TS:** `companyStatePath` and the dispatch, the seed tree and seeded paths, and `creationUnits`, after
  P16a and #751. A creation before P16a would send kinds the hook refuses.

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
- `agents/groups/`, `connections/`, `human-tasks/`, `contacts/`, `skills/` with the seeded skill
  `skills/human-task/SKILL.md` (`COMPANY_STATE_HUMAN_TASK_SKILL`, an ordinary file a company may edit),
  and `rules/`.

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

