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

Kinds are recognised on the casefolded path, as the core keys paths. Every other file is an
ordinary file: one pattern match and nothing else. Files nested deeper (a note in
`routines/notes/`, a worker's output next to its brief) are ordinary.

The parser is `@qorpera/cloud-client/company-state-files` (`companyStatePath`,
`parseCompanyStateFile`, the canonical `write*File` writers and `setCompanyStateSettings`).
The runtime, the web app, the object gateway and the folder service all use it. The database
repeats the pattern table in `qorpera_structured_path_kind(path)`, and a test compares the two
on the same list of paths.

### Names

Folder and file names (agent and group folders, routine, todo, rule and connection files,
todo and worker folders) follow contract 5.6: lowercase `a–z`, digits and single hyphens, at
most 64 characters, as written (not only casefolded). `companyStateName` makes one from a
display name (æ → ae, ø → oe, å → aa, accents dropped, spaces to hyphens, the rest dropped);
`freeCompanyStateName` adds `-2`, `-3` for a taken name and uses the fallback (`agent`,
`group`) when nothing is left. `groups` is reserved under `agents/`. Uniqueness is checked by
the database, casefolded.

### The settings block

A strict subset of YAML 1.2, so any YAML reader reads the same values:

- The file starts with a line `---`; the block ends at the next line `---`. A UTF-8
  byte-order mark and CRLF line ends are accepted.
- One `key: value` per line. Keys are `[a-z][a-z0-9_]*`. Each kind has a closed set of keys:
  an unknown or repeated key is refused.
- Values: plain text, `"double-quoted"` (escapes `\" \\ \/ \n \t \uXXXX`) or
  `'single-quoted'`; a list on one line `[a, b]`; or a key with no value followed by indented
  `- item` lines. `#` after whitespace starts a note. Tabs are refused.
- Refused: flow maps, anchors, aliases, tags, block scalars (`|`, `>`), a plain value that
  starts with a YAML indicator or contains `": "`, and a plain value in a text field that YAML
  would read as something other than text (`true`, `null`, `42`, …): "put it in quotes".
- Types are the kind's: ids (lowercase UUIDs), whole numbers, UTC instants
  `YYYY-MM-DDTHH:MM[:SS[.ffffff]]Z` (a real date), clock times `HH:MM`, days
  `mon`…`sun`, IANA time zones.
- The body is everything after the closing line, with one leading blank line dropped and
  trailing whitespace trimmed. It is kept as written; the index keeps a copy.

A structured file is at most 64 KiB (core §5). Field limits are today's product limits.

## 2. Formats

### `vision/vision.md`

No settings block. The first line with text is `# ` and the company's name (1–120
characters). That name is the company's name everywhere; renaming the company is editing that
line. The rest is free. The platform seeds:

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
| `name` | yes | 1–160 characters |
| `role` | yes | 1–320 characters |
| `kind` | yes | `co-founder` or `agent` |
| `status` | yes | `active` or `archived` |
| `colour` | no | charcoal, brown, coral, orange, gold, green, teal, blue, purple, pink, gray (the app's `qorpera-<colour>` tokens) |
| `figure` | no | planet, acorn, flame, rocket, crown, heart, ghost, brain (the Co-Founder) |
| `model` | no | gpt-6-astra, gpt-6-sol, gpt-6-luna: used when no conversation or routine picks one |
| `effort` | no | low, medium, high; default low |
| body | yes | the instructions (today's charter), up to 32 KiB |

Database rules: the Co-Founder is `qorpera_company_cofounders`; only it has
`kind: co-founder`, and it cannot be archived. `id` never changes and is unique; a copy of an
agent folder is refused. A new folder's name follows the naming rule and is unique.

Review (agent writers only, core §4): a new agent folder or `agent.md` (hire) and a change of
`status` are delegation. Deleting or moving the folder is deletion.

Refused (contract 5.6): deleting `agent.md` alone; moving an agent folder out of `agents/` or
into `agents/groups/`; deleting the Co-Founder's folder; any write under `agents/` from a
coding session.

**Pending decision 2:** a hire's first task is a todo file in the new folder, saved in the
same change set, instead of the hidden `startupInstructions` kickoff.

### `agents/sections.md`

No settings block. Lines before the first `## ` heading are free text. Each `## <name>`
(1–60 characters, unique ignoring case, may be empty) is a section, in order. Under a section,
each non-blank line is `- <id>` (or `* <id>`) followed by optional words for reading. Any
other line under a section, `###` headings, or an id line before the first section is refused
with its line number. An id appears at most once.

Database rules: every id is an agent or a group chat of this company (**pending decision 1**:
group chats are listed too, as #370 allows). Ids of deleted agents or closed group chats are
ignored, never refused, so an old line never blocks a save. The Co-Founder is refused. Agents
and group chats not listed are Unassigned. Pins and hidden agents stay member settings in the
database. Not reviewed.

### `agents/groups/<handle>/group.md`

| Key | Required | Values |
| --- | --- | --- |
| `id` | yes | UUID; the conversation follows it |
| `name` | yes | 1–256 characters |
| `subtitle` | no | up to 256 characters |
| `agents` | yes | list of agent ids, at least two, no repeats |
| `people` | no | list of member ids |
| body | yes | the purpose, up to 32 KiB |

Database rules: ids exist and are active; an agent's change may add to `people` only the
member its run works for (today's `create_group_chat` rule), since adding a person lets them
read the conversation. Review: a new `group.md` is delegation. Refused: deleting `group.md`
alone (deleting the folder closes the chat, its conversation stays); moving the folder out of
`agents/groups/`.

### `connections/<name>.md`

| Key | Required | Values |
| --- | --- | --- |
| `id` | yes | the vault record's id (`qorpera_cloud_secrets.id`) |
| `service` | yes | the connector id (gmail, github, google_drive, …) |
| `account` | yes | the mailbox or login, up to 254 characters |
| `status` | yes | `connected` or `broken` |
| `actions` | yes | the catalog's operation ids every agent may use |
| `connected_by` | yes | member id |
| `connected_at` | yes | UTC instant |
| body | no | what the account is for, written by the company |

The settings are written only by the platform, inside the vault's own transaction (core §3
step 4). Any other change to them is refused; the body is company-authored. The vault and the
operation grants stay the authority (contract 5.6). Deleting the file while connected is
refused; disconnecting removes it. Not reviewed.

### `rules/<name>.md`

| Key | Required | Values |
| --- | --- | --- |
| `id` | yes | UUID; review records cite it |
| `outcome` | yes | `ask-first` or `allow` |
| body | yes | one sentence on one line, "When an agent wants to …", up to 280 characters |

Only owners and admins write `rules/` (members' commits; a card's "Always allow" writes as
the answering owner or admin). Agents never write it; personal rules stay rows. Never
reviewed.

### `agents/<handle>/routines/<name>.md`

**Pending decision 3:** exactly one trigger per file.

| Key | Required | Values |
| --- | --- | --- |
| `id` | yes | UUID: the routine id cursors and occurrences use |
| `title` | yes | 1–160 characters |
| `status` | yes | `active`, `paused`, `concluded` ("expired" is derived by the scheduler) |
| `when` | yes | `every`, `weekly`, `window`, `once`, `file-change` |
| `minutes` | every, window | 5–10080 |
| `starts` | every, weekly: optional | UTC instant |
| `days` | weekly (required), window (optional) | list of `mon`…`sun` |
| `time` | weekly | `HH:MM` |
| `from`, `to` | window | `HH:MM`, `from` ≤ `to` |
| `months` | window: optional | list of 1–12 |
| `at` | once | UTC instant; before `ends` |
| `watch` | file-change | a path in the company; a trailing `/` is dropped |
| `match` | file-change: optional | `exact` or `subtree` (default) |
| `timezone` | all but `every`, and whenever `quiet` is set | IANA name |
| `ends` | no | UTC instant |
| `runs` | no (not for `once`) | 1–100000 |
| `quiet` | no | `"HH:MM-HH:MM"`, start ≠ end |
| `effort` | no | low, medium (default), high, xhigh, max |
| `reply` | no | optional (default), required, silent |
| `conclusion` | when concluded, and only then | 1–2000 characters |
| body | yes | what to do each time, up to 32 KiB |

A key of another `when` is refused by name. The owner is the agent whose folder holds the
file; moving the file to another agent's `routines/` hands the routine over. Each saved
change of the parse is a new routine version; schedule positions follow the 2026-09-25 rules
(same timing keeps its position) by comparing the timing of the two parses, keyed by the
routine id with one trigger. Who pays for a routine's runs is not in the file (the "starter
pays" work, S2).

Review: an agent creating, changing, moving or deleting a routine is delegation, except the
routine run's own end-of-run decision: the actor's wake is this routine's occurrence, and
only `at`, `effort`, `reply`, or `status: concluded` with `conclusion` change.

Archiving an agent pauses its routines: the follow-up queue writes `status: paused` into each
active routine file as a platform commit, so a restore does not revive them.

### `agents/<handle>/todos/<name>.md`

| Key | Required | Values |
| --- | --- | --- |
| `id` | yes | UUID; workers reference it |
| `title` | yes | 1–200 characters |
| `status` | yes | `open`, `blocked`, `done`, `cancelled` |
| `requested_by` | no | member id; without it the todo is the agent's own |
| body | no | what to do and what done looks like, up to 4000 bytes |

Database rules (today's): `done` is refused while a worker is active; a closed todo is not
opened again (a new file is); `cancelled` stops its active workers (follow-up queue); moving a
todo with an active worker is refused. Not reviewed; dispatching a worker is.

### Worker brief and results

`agents/<handle>/todos/<todo>/<worker>/brief.md`:

| Key | Values |
| --- | --- |
| `id` | the worker's id |
| `title` | 1–200 characters |
| `species` | `in-house` or `coding` |
| `access` | `read` or `write` |
| `revival` | `each` or `batch` |
| `dispatched_at` | UTC instant |
| body | goal, what done is, context, sources, output, cancellation and completion; follow-ups are appended |

`…/results.md`: `outcome` (succeeded, blocked, failed, cancelled), `reported_at`,
`decision` (accepted, rejected) and `note` (with a decision, up to 1000 characters); body:
summary, what it needs, the files it made.

Only the platform writes these two files: at dispatch and follow-up, and at report and
decision, for every worker species (contract 13). The worker's folder also holds the files a
write-access worker makes (today `work/todos/<agent>/<todo>/<worker>/`).

## 3. Refused files

A unit whose structured file cannot be read, or breaks a rule, is `refused`. The live file
stays at its old version and the refused bytes stay on the commit's receipt, like a conflict
copy. The other units of the change set still land, except units that depend on it (a todo in
a new agent folder whose `agent.md` was refused).

Outcome shape (core §3 "Outcomes"):

```json
{ "unit": 2, "op": "write", "path": "agents/nora-dahl/agent.md", "outcome": "refused",
  "reason": "structured_invalid",
  "problems": [ { "line": 6, "key": "status", "code": "value",
                  "message": "status must be one of: active, archived (found \"on leave\")" } ] }
```

- `structured_invalid`: the shared parser's problems (codes `too_large`, `encoding`,
  `front_matter`, `syntax`, `unknown_key`, `duplicate_key`, `missing`, `value`, `quote`,
  `name`, `body`). The writer sends `structured: {kind, text, problems}` and the commit
  records the refusal, so every writer reports the same way.
- `structured_rule`: a database rule (an unknown id, a taken name, a second Co-Founder, a
  platform-only field).
- The 5.6 refusals keep their own reasons (`seeded`, `cofounder`, `coding_session_read_only`,
  `rules_owner_only`, `connected`, `lone_structured_file`, `out_of_place`).

Messages name the fix: a missing id comes with a fresh one; an unknown key lists the allowed
ones; a bad folder name suggests one. Agents see them in the tool result or the shell report
(F3); members in the editor; everyone on the commit in the history view.

## 4. Indexes

Each kind has one index, written in the commit's step 8 and pointing at the exact path version
it came from. An index never decides anything the file does not say; it may hold a copy of the
body for readers that should not reach the storage server.

| Kind | Index | Keeps | Stays runtime state |
| --- | --- | --- | --- |
| vision | new `qorpera_folder_company_index` row | name, vision version, `vision_seeded`; `qorpera_profiles.name` is copied by the follow-up queue | — |
| agent | `qorpera_profile_staff` | every setting, the instructions (charter), handle, path, path version; retired on folder delete | lifecycle (setup), execution authority |
| sections | sidebar sections and placements (+ #370's room placements) | section order, members in order | member pins and hidden |
| group | `qorpera_company_rooms`, room members | name, subtitle, purpose copy, members | conversation, drafts, mentions, session model |
| connection | `qorpera_cloud_secrets` descriptor columns | path, path version, purpose copy | secret versions, grants, audit |
| rule | `qorpera_review_rules` (company scope) | outcome, text copy | personal rules, review records |
| routine | `qorpera_cloud_routines`, `_versions` | owner from the folder, title, trigger, timezone, ends, runs, quiet, effort, reply, status, conclusion, intent copy | schedule cursors, occurrences, retries, sponsor |
| todo | `qorpera_runtime_agent_todos` | owner from the folder, title, status, requester, detail copy | — |
| worker-brief/results | `qorpera_runtime_workers` | dispatch and result copies | handles, leases, revival, completion |

- **Moves** repoint index rows without re-parsing; an agent rename carries its routines and
  todos (core §5).
- **Deletes** mark rows retired at the last version; runs and conversations that reference
  them keep working. **Restores** re-parse and bring them back.
- **Rebuild:** a job lists every structured path, reads the bytes, parses them with the
  shared parser and calls `qorpera_folder_index_rebuild(env, kind, rows)`, which fixes rows
  under the same locks as a commit. In dry-run mode it is the daily drift check, reported to
  operators only.
- **Follow-ups** (core §5 "After the commit"): a hire's session, grants and first run; an
  archive's paused routines and revoked secret grants; a cancelled todo's workers; the company
  name copy. Consumers that must react at once (wake admission, routine firing, the secret
  broker, coding admission, screens, run authority) read the index directly.

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
| memory, skills | `agents/<id>/…` | `agents/<handle>/…`, through one agent-folder helper |
| rules (reviewer) | rule rows | the rule index, with versions read; personal rules unchanged |
| connections | vault rows and grants | the same, plus the purpose copy |

Tools: `hire_agent`, `create_group_chat`, `organize_sidebar`, `manage_todo`,
`manage_routine` and `decide_routine` become thin writers of these files (canonical writers
here, or `setCompanyStateSettings` for a one-key change) until the mount's writes are
accepted (F3). Then all but `decide_routine` retire. `decide_routine` stays, because the
kernel enforces the routine run's decision.

## 6. What the web app reads

| Screen | Reads | A save writes |
| --- | --- | --- |
| sidebar | agent, sections and group indexes; own pins and hidden | `agents/sections.md` |
| agent details | agent index; `agent.md` for the instructions | `agent.md` (`setCompanyStateSettings` for one setting, `writeAgentFile` for new) |
| new agent | — | new folder: `agent.md`, first todo |
| group chat details | group index | `group.md` |
| routines | routine index, runs from occurrences | the routine file |
| Settings → General → Rules | rule index, own rules | `rules/<name>.md`; own rules as today |
| Settings → Connections | vault rows, file body | vault actions write the file; the purpose edits the body |
| company name | vision index | the first line of `vision.md` |
| Company File page (#386) | the folder | any file; a refused save shows its problems |

The index tables keep their Realtime hints. The file page follows the folder feed (core §6,
C4). After a save, the app waits for the index row to reach the path version it wrote,
instead of today's `revision`.

## 7. The hook interface with the storage core

Proposed to F1 on #408 (comment 5864281465). F1 owns the commit, its lock order, the
follow-up queue table and drain loop. F2 owns the functions it calls. All are plpgsql,
security definer, `search_path = ''`, called only from the commit or the rebuild; they raise
only for malformed calls.

| Core §3 step | Function | Does |
| --- | --- | --- |
| before tx (TS) | `parseCompanyStateFile(path, text)` | a structured unit carries `structured: {kind, text, parse}` or `{kind, text, problems}`; SQL re-hashes `text` against the unit's file hash |
| any | `qorpera_structured_path_kind(path)` | the pattern table |
| 4, plan | `qorpera_folder_structured_targets(env, actor, units)` | no locks; index rows by parse id, subtree units by index path prefix as of `asOfSeq`, unique claims; with rank and mode |
| 4, lock | `qorpera_folder_structured_lock(env, targets, from_rank, to_rank)` | closed list of tables; called for ranks 2, 4–5 and 8–9 |
| 7, per unit | `qorpera_folder_structured_decide(env, actor, unit_no, unit, base_entry)` | schema, database rules, 5.6 refusals → `{ok, reason, problems}` |
| 7, review | `qorpera_folder_structured_review_class(kind, base_parse, new_parse, actor, op)` | plain, delegation, deletion |
| 8, per clean unit | `qorpera_folder_structured_apply(env, commit_id, unit_no, unit, version)` | index rows, the parse, follow-up rows |
| 9 | `qorpera_folder_structured_verify(env, commit_id)` | index rows point at current versions |
| after | `qorpera_folder_converge_<kind>(env, subject)` | idempotent follow-ups |
| any | `qorpera_folder_index_rebuild(env, kind, rows)` | rebuild and drift check |

Open with F1: the parse stored on the path version (`structured jsonb`); same-change-set units
exempt from the unseen-change check (a rename writes `agent.md`, then moves the folder); who
wires the dispatch (C2); the company index row instead of locking the profile row; which slice
brings agent actors and the session kind.

## 8. Build order

1. **F2-0** (this): this document and the shared parser, with tests. No SQL; inert.
2. **F2-1** vision and agents: pattern table, company index, staff index for `folder-v2`,
   Co-Founder and naming rules, seeding templates, hire / rename / archive / delete, the
   follow-ups, the context composer, and the agent-folder helper for memory and skills.
3. **F2-2** group chats and sections (replaces #370's tables and `organize_sidebar` for new
   companies).
4. **F2-3** connections (the vault writes the file).
5. **F2-4** rules (the reviewer reads the rule index).
6. **F2-5** todos and worker files.
7. **F2-6** routines (last: scheduler, positions and decisions).

Each after F1's C1 (and the C2 dispatch), `folder-v2` only, on the release train, with an
independent exact-head review. The web screens for each kind follow with core step C4.
