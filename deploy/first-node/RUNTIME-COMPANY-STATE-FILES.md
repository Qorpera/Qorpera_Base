# Company state files

Status: design, with the shared parser built (F2-0). Nothing reads or writes these files in
production yet. This is workstream F2 of the Rebuild Map: company state moves out of database
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
wrong spelling. A subtree move checks the moved folder's new name; the names inside it do not
change. A failed path check refuses the unit as `structured_invalid` with `name` problems.

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
`010`, `0b101`, `0x1F` or `1_000` as a boolean or a number. The canonical writers quote forms
like these, but not instants.

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
| body | yes | the instructions (today's charter), up to 32768 bytes trimmed |

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
- Every id the save adds is an agent or a group chat of this company (**pending decision 1**:
  group chats are listed too, as #370 allows).
- An id already in the saved version is never refused, even if its agent is gone or its group
  chat is closed. The index skips it, so an old line never blocks a save.
- The Co-Founder is refused.

Agents and group chats not listed are Unassigned, in roster order. Today's placement positions
for Unassigned are not kept. Pins and hidden agents stay member settings in the database. Not
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
  archived, or a person who leaves, never blocks a later save of the file. The index skips
  them.
- An agent's change may add to `people` only the member its run works for (today's
  `create_group_chat` rule), because adding a person lets them read the conversation.

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

- **Settings:** written only by the platform, inside the vault's own transaction (core §3 step
  4). Any other change to them is refused.
- **Body:** company-authored.
- **Authority:** the vault and the operation grants stay in charge (contract 5.6).
- **Deleting:** refused while the vault record is active, whether `connected` or `broken`.
  Disconnecting removes the file.
- Not reviewed.

### `rules/<name>.md`

| Key | Required | Values |
| --- | --- | --- |
| `id` | yes | UUID; review records cite it |
| `outcome` | yes | `ask-first` (`ask_first`) or `allow` (`allow_automatically`) |
| body | yes | how "When an agent wants to …" ends, as today's `when_text`: one line, 1–280 characters trimmed, no controls |

- **Who writes:** only owners and admins write `rules/` (members' commits). A card's "Always
  allow" writes as the answering owner or admin. Agents never write it. Personal rules stay rows.
- **Budget:** the company rule budget of 48 KiB (`qorpera_review_rules_assert_room`) stays a
  database rule.
- Never reviewed.

### `agents/<handle>/routines/<name>.md`

**Pending decision 3:** exactly one trigger per file.

| Key | Required | Values |
| --- | --- | --- |
| `id` | yes | UUID: the routine id cursors and occurrences use |
| `title` | yes | 1–160 bytes |
| `status` | yes | `active`, `paused`, `concluded` ("expired" is derived by the scheduler) |
| `when` | yes | `every`, `weekly`, `window`, `once`, `file-change` |
| `minutes` | every, window | 5–10080 |
| `starts` | every, weekly: optional | UTC instant |
| `days` | weekly (required), window (optional) | list of `mon`…`sun`, at least one |
| `time` | weekly | `HH:MM` |
| `from`, `to` | window | `HH:MM`, `from` ≤ `to` |
| `months` | window: optional | list of 1–12, at least one |
| `at` | once | UTC instant; before `ends` |
| `watch` | file-change | a path in the company; a trailing `/` is dropped |
| `match` | file-change | `exact` or `subtree` |
| `timezone` | all but `every` | IANA name |
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
- Who pays for a routine's runs is not in the file (the "starter pays" work, S2).

**Versions and schedule positions:**
- Each saved change of the parse is a new routine version.
- Schedule positions follow the 2026-09-25 rules: the same timing keeps its position. The rules
  compare the two parses' timing, keyed by the routine id with one trigger. Instants are
  compared canonically, so re-spelling `starts` changes nothing.

**Database rules (contract 16.3):**
- While a run owes its routine's end-of-run decision, a unit from that run on that routine's
  file may only be the decision. The decision either sets a new `at`, optionally with a new
  title, instructions, effort or reply, or concludes with a `conclusion`. The run cannot pause,
  remove, move or otherwise change its own routine.
- A member's commit cannot create a `when: once` routine, or change a routine to it: "a
  member's save … cannot create a dynamic routine".
- The platform writes `status: paused` for:
  - an agent's archiving (the follow-up queue, so a restore does not revive the routine);
  - the authorization-failure suspension;
  - a member's Stop of a dynamic routine's run;
  - a routine left without a model account.

  Each platform commit records its reason. The index keeps it as `pause_reason`.

**Review:** an agent creating, changing, moving or deleting a routine is delegation. The one
exception is the routine run's own end-of-run decision, when the actor's wake is this routine's
occurrence and only `at`, `effort`, `reply`, or `status: concluded` with `conclusion` change. A
decision that also changes the title or the instructions is reviewed as delegation (contract
16.3; `cloud-action-review.ts`).

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
- Moving a todo with an active worker is refused.
- `requested_by` is checked only when the save changes it.

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
- `structured_rule`: a database rule, such as an unknown id added, an unknown time zone, a
  taken name, a second Co-Founder, a platform-only field, `no_agent`, `kind_change` or
  `structured_copy`.
- The 5.6 refusals keep their own reasons: `seeded`, `cofounder`, `coding_session_read_only`,
  `rules_owner_only`, `connected`, `lone_structured_file`, `out_of_place`.

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
| agent | `qorpera_profile_staff` | every setting, the instructions (charter), handle, path, path version; retired on folder delete | lifecycle (setup), execution authority |
| sections | sidebar sections and placements (+ #370's room placements) | section order, members in order | member pins and hidden |
| group | `qorpera_company_rooms`, room members | name, subtitle, purpose copy, members | conversation, drafts, mentions, session model |
| connection | `qorpera_cloud_secrets` descriptor columns | path, path version, purpose copy | secret versions, grants, audit |
| rule | `qorpera_review_rules` (company scope) | outcome, `when_text` copy | personal rules, review records |
| routine | `qorpera_cloud_routines`, `_versions` | owner from the folder, title, trigger, timezone, ends, runs, quiet with its zone, effort, reply, status, conclusion, intent copy | schedule cursors, occurrences, retries, sponsor, `pause_reason`, `authorization_failures`, `origin` (who created it, from the first commit) |
| todo | `qorpera_runtime_agent_todos` | owner from the folder, title, status, requester, detail copy | — |
| worker-brief/results | `qorpera_runtime_workers` | dispatch and result copies | handles, leases, revival, completion |

- **Moves** repoint index rows without re-parsing. An agent rename carries its routines and
  todos along (core §5).
- **Deletes** mark rows retired at the last version. Runs and conversations that reference them
  keep working. **Restores** re-parse and bring them back.
- **Rebuild:** a job lists every structured path, reads the bytes and parses them with the
  shared parser. It then calls `qorpera_folder_index_rebuild(env, kind, rows)`, which fixes rows
  under the same locks as a commit. In dry-run mode it is the daily drift check, reported to
  operators only. Each stored parse records `COMPANY_STATE_PARSER_VERSION`, so drift from a rule
  change is told apart from drift in the data.
- **Follow-ups** (core §5 "After the commit"):
  - a hire's session, grants and first run;
  - an archive's paused routines and revoked secret grants;
  - a cancelled todo's workers;
  - the company name copy.

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

Proposed to F1 on #408 (comment 5864281465). F1 owns the commit, its lock order, and the
follow-up queue table and its drain loop. F2 owns the functions it calls. All are plpgsql,
security definer, `search_path = ''`, and called only from the commit or the rebuild. They
raise only for malformed calls. `decide` checks every index constraint, so `apply` never raises
on a unit that `decide` passed.

| Core §3 step | Function | Does |
| --- | --- | --- |
| before tx (TS) | `parseCompanyStateFile(path, text)` | Each structured path of a unit gets an entry in `structured: [{path, kind, text, parse, parserVersion}]`, or `[{path, kind, problems}]` without the text when refused. A `new_folder` lists every structured file inside it. SQL re-hashes each parsed file's text against its file hash. |
| any | `qorpera_structured_path_kind(path)` | The pattern table, on the key. |
| 4, plan | `qorpera_folder_structured_targets(env, actor, units)` | Takes no locks. Returns the rows to lock, each with its rank and mode: index rows by parse id, index rows by path prefix for a subtree unit as of its `asOfSeq`, referenced member rows (`people`, `requested_by`, `connected_by`: rank 1, KEY SHARE), and unique claims. |
| 4, lock | `qorpera_folder_structured_lock(env, targets, from_rank, to_rank)` | Locks through a closed list of tables. Rank 1 is merged with the actor's own member row in member-id order. Called for ranks 1–2, 4–5 and 8–9. |
| 7, per unit | `qorpera_folder_structured_decide(env, actor, unit_no, unit, base)` | Runs after F1's own checks. Covers the database rules, the dependency rule and the 5.6 refusals, and returns `{ok, reason, problems}`. `base` is the index as the earlier units left it. |
| 7, review | `qorpera_folder_structured_review_class(kind, base_parse, new_parse, actor, op)` | Returns plain, delegation or deletion. The TS proposal before the transaction applies the units in the same order, so both sides agree. |
| 8, per clean unit | `qorpera_folder_structured_apply(env, commit_id, unit_no, unit)` | Writes the index rows, the parse and the follow-up rows. It finds each file's new version in `qorpera_folder_path_versions` by (commit, unit, key). |
| 9 | `qorpera_folder_structured_verify(env, commit_id)` | Checks that each index row written points at its entry's current version. |
| after | `qorpera_folder_converge_<kind>(env, subject)` | The follow-ups, safe to repeat. |
| any | `qorpera_folder_index_rebuild(env, kind, rows)` | Rebuild and drift check. |

**Settled:** a rename writes `agent.md`, then moves the folder, in one change set.
- C1a's unseen-change check is `c.seq > v_as_of`, and the running commit's `seq` stays NULL
  until the clock step, so a unit's own earlier writes never count. Writing a child does not
  change the folder's version, so the move's `expectedVersion` holds.
- The reverse order (move, then write with the old version) conflicts.
- Asked of F1: make the exclusion explicit (`c.id <> v_commit_id`) and cover it with a test.

**Open with F1:**
- where the parse is stored: `structured jsonb` on the path version;
- who wires the dispatch (C2);
- the company index row, so the profile row is never locked;
- which slice brings agent actors and the session kind.

## 8. Build order

1. **F2-0** (this): this document and the shared parser, with tests. No SQL; inert.
2. **F2-1** vision and agents:
   - the pattern table, the company index, and the staff index for `folder-v2`;
   - the Co-Founder and naming rules, and the seeding templates;
   - hire, rename, archive and delete, with their follow-ups;
   - the context composer;
   - the agent-folder helper for memory and skills.
3. **F2-2** group chats and sections (replaces #370's tables and `organize_sidebar` for new
   companies).
4. **F2-3** connections (the vault writes the file).
5. **F2-4** rules (the reviewer reads the rule index).
6. **F2-5** todos and worker files.
7. **F2-6** routines, last because the scheduler, schedule positions and decisions are the
   most delicate part.

Each step comes after F1's C1 (and the C2 dispatch), is `folder-v2` only, rides the release
train, and gets an independent exact-head review. The web screens for each kind follow with
core step C4.
