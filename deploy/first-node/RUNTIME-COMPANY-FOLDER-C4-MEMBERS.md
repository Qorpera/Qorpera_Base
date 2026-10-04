# The company folder for members: reads, history and the hint (C4, P27 and P30)

Part of [the company folder core](RUNTIME-COMPANY-FOLDER-CORE.md), §6 ("Clients") and §11 C4: "the members' and
clients' hint" and the member routes. Slices P27 and P30 of the folder core plan (coordinator audit, 2 October 2026),
moved from F3 to the Interfaces session on 3 October 2026. The web file page and history on folder-v2 (P33) are built
on them. Member writes (§5, P34a) are open everywhere but `human-tasks/`, which waits until human-task wakes run
on the listener (P31).

Everything here serves folder-v2 companies only. A snapshot-v1 company never reaches it: each function refuses an
environment that is not folder-v2, as the core's reads do.

## 1. What a member can do

- **Read** one path: the entry (kind, version, size, media type, hashes, when it changed) and `asOfSeq`.
- **List** one folder, a page at a time, in folder-key order.
- **Fetch the bytes** of a file they may read: its manifest, then its chunks, through the object gateway.
- **See history:**
  - a path's versions, newest first, each with who changed it and when, and what the content was then;
  - the company's change sets, newest first, each with who, when, and the paths in it the member may read.
- **Follow changes:** the feed after a position, with who made each change set, to refresh what is on screen.
- **Hear that something changed:** a hint on a private Realtime topic, after which the client asks the feed.

A path the member may not read looks absent everywhere, as in the core's reads (`qorpera_folder_actor_allowed`). History
and the feed check read authority now, against the path's current resource: a path the member could read last week
but not today shows nothing.

## 2. How a member reaches the core (P27)

The core's reads, the feed and the byte check take an actor and are for `service_role` only. A member's own actor is
`{"kind": "member", "userId": <auth.uid()>}`, which `qorpera_folder_read_actor` already accepts.

- **The caller check.** Each of `qorpera_folder_read`, `qorpera_folder_list`, `qorpera_folder_feed` and
  `qorpera_folder_authorize_object_download` starts with "service_role, or refuse". It becomes "service_role, or an
  authenticated member whose actor is exactly their own" (`qorpera_folder_caller_allowed(p_actor)`). The functions
  stay closed to `authenticated` (no grant): only the member functions below reach this branch. An exact-text patch
  of the one check line, with a body marker.
- **Member functions** (`authenticated`, each a membership check before anything else, then the core with the
  member's own actor). Membership is read without a lock: these are reads.
  - `qorpera_member_folder_read(environment, path)`
  - `qorpera_member_folder_list(environment, parent, after, limit)`
  - `qorpera_member_folder_path_history(environment, path, before, limit)` and
    `qorpera_member_folder_history(environment, before, limit)`: new, below.
  - `qorpera_member_folder_changes(environment, after_seq, limit, cursor)`: the feed, plus each change set's
    attribution (`by`, `at`) from its commit row.
  - `qorpera_member_folder_object(environment, sha256)`: the byte check, for the object gateway's member route.
- **Why not gateway routes for every read:** the web already lists and reads a governed company's Company File with
  PostgREST calls and fetches only bytes from the gateway (`cloud-member-company-file.ts`). The member functions keep
  that shape, so the folder-v2 file page (P33) is the same client with new calls, and a listing costs one database
  call instead of an Edge Function, the gateway and two database calls. Writes need the gateway (uploads and
  their intents), and get it in §5.
- **Bytes.** The object gateway gets a member route, `GET /v1/member-folder-objects/<environment>/<sha256>`, behind
  the member company gateway as the other member routes are. It calls `qorpera_member_folder_object` with the
  member's token, then serves that one object from the NAS: a manifest or a chunk, as the runs' folder route does.
  The client reads the manifest and fetches its chunks. An old version's content is readable when the member may read
  the path version that references it (`qorpera_folder_object_readable`).
- **A company being deleted** refuses members' reads (55000, since #700). A paused company still lets members read.

### History

Both answer `{schema, asOfSeq, items, next}`, newest first; `next` continues an older page.

- **A path's versions:** `qorpera_member_folder_path_history(p_environment_id uuid, p_path text, p_before uuid,
  p_limit integer)` (`qorpera.folder-path-history/v1`, at most 100 a page). It reads `qorpera_folder_path_versions`
  by key, newest first (the existing index on environment, key and time), when the member may read the path now.
  Each item: `version`, `seq`, `op` (write, mkdir, delete, move_in, move_out, copy), `kind`, `path`, the content
  fields, `at`, `by`. A `move_in` names the path it came `from`, and a `move_out` the path it went `to`, only when the
  member may read that path too, as the feed does with `priorVersion`. `p_before` and `next` are a version of this
  path.
- **The change sets:** `qorpera_member_folder_history(p_environment_id uuid, p_before bigint, p_limit integer)`
  (`qorpera.folder-history/v1`, at most 50 a page), from the journal. Each item: `seq`, `at`, `by`, and the paths in
  it the member may read (`path`, `op`, `kind`, `version`): the first 20 in unit order, with `more` when it has
  others they may read or more than 1,000 versions. A change set's versions are examined in unit order until a 21st
  readable one, and at most 1,000 of them. A change set none of whose first 1,000 versions the member may read is
  left out, like one with no readable path; the feed and a path's history still show its changes. Authority rows
  are left out. Work per call is bounded: at most `p_limit` change sets, and 10,000 versions in all; a change set the
  remaining budget can't examine whole goes to the next page. `p_before` and `next` are a seq.
- **`by`:** `{kind: "member", userId}`, `{kind: "agent", staffAgentId}` or `{kind: "platform"}`, from the commit's
  attribution columns. The member who asked an agent is not shown: the conversation may be private to them. The
  client shows names from the members and agents it already has.

### Positions in the feed for members

The feed's position can name a change the member may not read: its unit number and version uuid, never its path
(core §6, C1f). A version uuid opens nothing: bytes are authorized by hash and readability, and history by path. The
member functions return the position as the feed gives it. The count of changes it implies is what `asOfSeq` already
shows.

## 3. The hint (P30)

The folder clock stays out of the Realtime publication. Publishing a table makes Realtime send every subscriber who
may not select it an "unauthorized" event per change, which would show anyone the timing of every commit (C1f).

- **A broadcast on a private topic.** When a folder-v2 company's clock moves forward, the database sends
  `{schema: "qorpera.folder-hint/v1", seq}` as event `folder` on topic `qorpera-folder-<environmentId>`, with
  `realtime.send(…, private => true)`. An AFTER UPDATE trigger on `qorpera_folder_clocks` sends it, when `last_seq`
  grows.
- **Who receives it:** a policy on `realtime.messages` lets an authenticated member of that company read broadcasts
  on that topic, as room drafts do. There is no insert policy: only the database publishes. Someone who is not a
  member cannot join the topic, so they see nothing, not even refusals per change. `service_role` (a node's folder
  service) can join any topic.
- **What it says:** only that the folder changed, and up to which seq. `last_seq` reveals only that something changed
  (core §6), and every read already returns `asOfSeq`.
- **Cost in the commit.** The commit takes the clock row last and holds it to its end, so the send runs under it. A
  send only inserts a row into `realtime.messages`, read from the WAL after commit. The send has a 20 ms lock budget
  and absorbs every failure (as the orchestrator wake does, 20260928319550): a hint never fails or holds up a commit.
- **Coalescing.** At most one hint per clock update, and a commit updates the clock once. The client coalesces too:
  on a hint it asks the feed at most once per second, and a slow poll backs it up for a hint that never arrived.

## 4. Slices

| Slice | Contents | Migration, tests |
| --- | --- | --- |
| P27a | the caller check; the six member functions; history | `20260930013000`, SQL tests 833 (reads, list, bytes check), 834 (history, changes) |
| P27b | the object gateway's member folder route and the member company gateway's route; cloud-client's member folder client (parsers tested against real SQL output) | none |
| P30 | the hint trigger, topic and policy; cloud-client's hint subscription | `20260930013100`, SQL test 835 |
| P33 | the web file page and history on folder-v2 (#386's approved file browser, read only); the member's file mode says `folder`; the hint's subscription in cloud-client | `20260930013200`, SQL test 836 |
| P34a-1 | member writes (§5): the writer check, the state folders read, the object gateway's member commit route and the member company gateway's route, cloud-client's writer | `20260930021000`, SQL test 898 |
| P34a-2 | the web's agent, group chat and skill editors on the folder (§5) | none |
| P34r | the web's routine editor on the folder (§6): the state folders read lists routines' files | `20260930038000`, SQL test 899 |

Each is inert until a folder-v2 company exists.

## 5. Member writes for the web's editors (P34a)

Since the wipe on 3 October every company is folder-v2. The web's editors for agents and group chats wrote the
governed Company File, so they refuse now. P34a gives members a write route and moves those editors and the skill
suggestions onto the folder (the coordinator, 3 October). P34b, the other editors (rules, sections, routines), follows
P31.

**The hold** (H2; F2, 3 October). A member's save under `human-tasks/` queues a wake for the agent that only P31
delivers. Until P31 the route refuses the whole request (403, before any byte is staged) when any unit is at or under
`human-tasks/`: a write, a mkdir, a new folder, a delete, and either end of a move. The test is on the folder key
(`companyPathKey`, the same fold as `qorpera_folder_key`). Everything else is open. Contacts queue no wake, and their
rules already run in SQL.

**SQL** (`20260930021000`, SQL test 898). Both are reads, without a lock.
- `qorpera_member_folder_writer(environment)` (`authenticated`) answers the member's own actor
  `{"kind": "member", "userId": auth.uid()}` and the company's profile id. It answers only for a member of a
  folder-v2 company that is neither being deleted nor paused (55000). Staging refuses a paused company for every actor
  while the commit does not, so the check refuses it for every member write alike; members still read while paused.
  The gateway calls it with the member's token, and that is how it learns who the member is. Every write then goes to
  the core as that actor with the service key, and the core checks the actor's shape, the membership row (rank 1, so a
  member removed meanwhile is refused), each path's authority and each upload intent's owner (intents are scoped by
  user, so no member can put into, confirm or seal another's).
- `qorpera_member_company_state_folders(environment)` (`authenticated`) answers the live agents' and group chats'
  files the member may read: `{agents: [{staffAgentId, file}], groups: [{roomId, file}]}` (`agent.md` and
  `group.md`; a folder is its file's parent). It reads the staff and
  room rows' `folder_path` and leaves out retired rows. The web knows agents and rooms by id from its other reads, so
  this finds an id's folder without reading every `agent.md`.

**The gateway route**, `POST /v1/member-folder-commits/<environment>`, sits behind the member company gateway like the
member's other routes (its Edge Function allows the route with a 1 MiB body), with CORS.
- **The request** is JSON, at most 1 MiB: `{schema: "qorpera.member-folder-commit/v1", operationKey, units}`, with
  1–16 units in closed shapes:
  - `write {path, text, expectedVersion?}`;
  - `mkdir {path}`;
  - `new_folder {path, contents}`, with at most 64 entries, each `{path, kind: "folder"}` or
    `{path, kind: "file", text}`;
  - `delete {path, expectedVersion?, asOfSeq?}`;
  - `move {from, to, expectedVersion?, asOfSeq?}`.

  Text is well-formed UTF-8: at most 64 KiB per file (the state files' bound), 512 KiB and 32 files per request
  (staged one after another, they must fit the member gateway's 25 s; a hire sends two). Paths pass
  `parseCloudCompanyPath`. The member's operation key is 1–128 characters of `[A-Za-z0-9._:-]`; the web sends
  `web:<uuid>`.
- **The key's namespace.** The core gives members the platform's operation-key scope, so a member could otherwise
  take a key a platform writer will use (`company-create:<id>`, `connection-file:<id>:<generation>`) and make that
  commit fail. The route sends `member:<userId>:<key>`, a namespace no platform writer uses (within SQL's 8–200).
  The same key from the same member is a replay of the same change set.
- **The steps:**
  1. every shape, path and size, before anything else (400, 413);
  2. the writer check, with the member's token (401 and 403 as on the other member routes);
  3. the hold;
  4. at most one change set in flight per member on the gateway (429);
  5. each file's bytes staged as the member: open the upload, put and confirm the objects the store lacks, then seal.
     This is A1's `PlatformFolderWriter`, with the actor as a parameter;
  6. each state file's entry, built from the same text by `parseCompanyStateFile`, as the runtime's `structured()`
     does: `{path, kind, text, parse, parserVersion}`, or `{path, kind, problems}` when the parse fails (the hook
     refuses it with those codes). `path` is the whole stored path, also for a new folder's contents;
  7. one `qorpera_folder_commit` as the member, with the namespaced key and neither a review nor a receipt;
  8. when the commit saved anything, its follow-up at once (F2's P15): the service-role
     `qorpera_folder_follow_up_commit(environment, commit)` settles one subject a call (a hire's default grant,
     connectors and first run; an archive's clean-up), and is called again while it answers `more`, at most 8 times
     and 3 s, before the answer goes back, and never after 20 s into the request (the bridge allows 25 s). It runs on
     its own database client, so a failing follow-up never opens the circuit members' commits use, and the member's
     one-at-a-time slot is free while it runs. A best effort: any error ends it (before P15 the function does not
     exist), and the core's own step converges whatever is left within about 2 s.
- **The answer** is the core's commit answer (`qorpera.folder-commit/v1`) as it is: for each unit, `saved`, or the
  outcome with its reason and problems. A lock conflict is 409: send the same request again, with the same key (a
  first try that did commit replays its outcome). A company being deleted or paused is 423.
- **Media types** are the runtime's: `text/markdown` for `.md`, `text/plain` for anything else.
- **No review:** members' changes are never reviewed. An agent's changes go through its own tools.

**cloud-client.** `CloudMemberFolderClient` gains `stateFolders()` and `commit(operationKey, units)`, with closed
parsers for both answers. A file's text is `read()` then `readFile()` (P27b), decoded as strict UTF-8. The web checks
a state file with `parseCompanyStateFile` before sending it, so a member sees a problem without a round trip.

**The web (P34a-2).**
- **Agents:**
  - *Create* is one `new_folder` `agents/<handle>` holding `agent.md` (`writeAgentFile`), `memory/`, `skills/`,
    `routines/` and `todos/`, as the runtime's hire makes it, without a first todo (see *Fields*). The handle comes
    from the name (`freeCompanyStateName` over the listed `agents/`); one taken since the listing is `exists`, and the
    next handle is tried with a new key.
  - *Edit* rewrites `agent.md`: its settings with `setCompanyStateSettings` and its body (the instructions), with
    `expectedVersion` from the read. The handle stays.
  - *Delete* removes the folder, with the folder entry's `version` and `asOfSeq` from one read of the folder. An
    active agent's runs write under its folder often, so a `conflict` (`unseen_change`) reads again and retries a few
    times. The Co-Founder's folder is never deleted (the hook refuses it; the web offers no delete).
  - *Fields:* `name`, `role`, `figure`, `colour` (the web's `qorpera-<colour>` token without its prefix, and back),
    and the instructions as the body. `model` and `effort` stay as read. Grants, model policy, lifecycle, template and
    department have no place in `agent.md` (grants come from the roster's defaults and path authority, placement from
    `sections.md`), so the editor drops them. The web's create form has no first assignment, so a web-made agent has
    no first todo and starts from its instructions when it is first messaged.
  - *Handles:* a free handle in the member's listing can be taken by another writer before the commit; `exists`
    picks the next handle with a new key. (A folder the member may not read is usually not writable either: the core
    answers `denied` there.)

  A new agent's kickoff run arrives with P15 (F2). Until then the agent waits for its first message. A deleted
  agent is fenced at once (no run, routine or message wakes it); until P15 its routines still read `active` in the
  index, though none can fire (F2, 4 October).
- **Group chats:** *create* is a `new_folder` `agents/groups/<handle>` holding `group.md` (`writeGroupFile`): the
  members' list becomes `agents` (at least two) and `people`. *Edit* rewrites `group.md` with `expectedVersion` from
  the read; the room's version number and key go, and a lost answer is found by reading the file again (each try
  has its own key). *Delete* removes
  the folder (with `asOfSeq`), which closes the chat.
- **Who may:** the web keeps today's owner-or-admin gates for agents and group chats, and the core's `denied` answers
  for anything a path's authority refuses.
- **Skill suggestions** read `skills/` and `agents/<handle>/skills/` through the folder client.
- **What goes:** `WebCompanyFiles.files()` and `mode()` (these three editors are their only callers; P34b's editors
  are written on the folder), the web's use of the governed editor client, and the agent JSON document.

## 6. The web's routine editor on the folder (P34r)

Every company is folder-v2, so a routine is a file, `agents/<handle>/routines/<key>.md`
(RUNTIME-COMPANY-STATE-FILES.md, "routines"), and `qorpera_upsert_cloud_routine` refuses a member's save there ("edit
those files"). So the agent routines page's switch, Edit and New routine do nothing on a folder-v2 company. The
coordinator moved the routine editor ahead of P31 (4 October): routines are not under `human-tasks/`, and a founder
tries them at milestone acceptance. The rest of P34b (rules, sections) waits for P31. Design review r1 (4 October) is
folded in below.

**Finding a routine's file** (migration `20260930038000`, SQL test 899). The routine list
(`qorpera_list_cloud_routines`) reads the index and does not say where a routine's file is; adding the path there would
show it to every reader of the company, past the path's authority. `qorpera_member_company_state_folders` also
answers `routines: [{routineId, staffAgentId, file}]`: the routine index rows with `profile_id`, this
`folder_environment_id`, `folder_retired_at` null and status not `retired`, whose file the member may read (`qorpera_folder_actor_allowed`, as
for agents), `staffAgentId` the row's owner, in path order. The web ships before the SQL (Pages deploys on merge; SQL
at a release), so cloud-client's parser takes `routines` as optional: missing means no routine file is known and every
routine reads as read-only.

**Who pays.** The file does not say who pays (STATE-FILES, "Ownership"), and a member's commit carries no sponsor. The
core takes the routine's own login when it still pays for this member, else the member's newest login that pays for
unattended work (`qorpera_company_state_routine_payer`). A new routine, a resume and any change of what a run pins need
one; a pause does not. So on folder-v2 the editor does not offer a choice of account: it says the routine runs on the
member's own account that works while they're away. Before every save that needs a login, the web runs today's
idempotent consent and bind (`qorpera_consent_provider_connection_autonomous`,
`qorpera_create_member_execution_sponsor`) on the member's first account that can pay and is switched on for
unattended use, so that account has a binding in this company. When none is switched on, the editor offers their
accounts that can pay (never a Claude login; a ChatGPT plan only once its member turned on work while away, and never
for a file-change routine) and switches the chosen one on first; the switch's Resume does as today's toggle does (the
first account that can pay); when nothing can pay, today's messages say where to connect or turn one on. Then it
commits the file as the member (§5's route). An exact choice among several paying accounts would need the commit to
take a preferred login: not in this slice.

**The trigger, both ways.** One exported helper in cloud-client, beside `writeRoutineFile`, maps the editor's shapes
to the file's keys and back, the inverse of the index's `qorpera_company_state_routine_trigger`, with a test pinned to
it:
- every N minutes (5 to 10,080) is `when: every`, `minutes`, and `starts`: now plus the interval for a new routine
  and for an edit that changes the interval; otherwise the file's `starts` exactly as read (present or absent), or
  removed when a held start is let go;
- days at a time is `when: weekly`, `days` (`mon`…`sun`), `time` (`HH:MM`), the top-level `timezone`, and `starts` as
  read (a past one too, which today's editor keeps): a held future start moves with the time, and one that is let go
  is removed;
- the keys of the other `when` are removed. `timezone` stays when an edit moves to `every`: quiet hours without their
  own zone take it. The zone field shows the file's `timezone` (also for an `every` file that keeps one), and an edit
  that changes it writes `quiet_timezone` with the old zone when quiet hours had none of their own, so they stay as
  read.

**The writes**, each through §5's member commit route, as the member:
- **New routine:** the routines folder is read first; when it is missing, a `mkdir` comes first in the same change
  set (each unit's outcome is read; a `mkdir` `exists` reads again and retries without it). Then one `write` of
  `agents/<handle>/routines/<key>.md` (`writeRoutineFile`) with a new id, `reply` (today's default, `required`) and
  `effort` (`low`, as today) written out. The key comes from the title (`freeCompanyStateName` over the listed
  routines' file stems, at most 64 characters); the write's `exists` takes the next key with a new operation key,
  unless the file at that path already carries this draft's id (a lost answer: it is saved).
- **Edit:** the form is filled from the file's parse, the same read that gives the version it names. It rewrites the
  file with `setCompanyStateSettings` (the title, the trigger's keys, `timezone`, `reply` from
  the editor's select) and `withStateBody` (the instructions). `effort`, `ends`, `runs`, quiet hours, notes and every
  other byte stay as read. When the new parse equals the one it read, nothing is written ("Nothing changed"): an
  unchanged save would resume a routine the platform paused, which only the switch does. A `version_changed` retries
  only while the re-read file's editor fields equal those the form opened with; otherwise it stops with "This routine
  changed while you were editing it" and the form reloads. A transport failure resends the same request with the same
  operation key (a replay); only an answer that saved nothing frees the key. A replay that saved is "saved"; a draft
  changed since is then written on top of what that request wrote, at the version its answer gives, so a change by
  someone else meanwhile meets `version_changed` and the check above. When that request made a new routine, the
  check's stop ends the save id too: the form, found in the list again by the file's id, opens on the routine's file
  with the changed-while-editing line, and the next Save edits it.
- **Pause:** `status: paused`, no login needed; nothing is written when the file already says `paused`.
- **Resume:** the login first (above); then `status: active`. When the file already says `active` (a pause the
  platform recorded in the index only: a member's Stop, a failing login, a wait for one, and P15's `agent_archived`
  once P15 lets a paid save end it), the file is saved unchanged, which ends that pause and pays like a resume, as the
  runtime's `manage_routine` does. While the agent is archived the switch stays locked (#777). Turning on a ChatGPT
  plan does not resume a folder-v2 routine; the member resumes it with the switch.
- Pause and resume retry a `version_changed` only while the re-read file says `active` or `paused`; a file now
  `concluded`, or a row now `expired`, stops and the list is read again.

**What the editor offers.** Every 5 to 10,080 minutes and days at a time. A file-change routine is refused on
folder-v2 until the folder's file events reach routines, so the editor stops offering it and its strings go. Read-only
cases: a routine with no known file (unreadable, or from before the files) has no switch and no Edit; an ended routine
(concluded, expired) has neither, as today; a dynamic routine (`once`) keeps its switch (the hook lets a member pause
it and resume it, paid) and has no Edit; a member never makes one. A routine the editor cannot show keeps no Edit, as
today.

**Answers.** A refusal carries the hook's problems (English, as in §5), shown under the editor; nothing was written.
New strings ("Nothing changed", the changed-while-editing line, the account line) get Danish. The routines list is
read again after every save, as today.

**Follow-up (not this slice).** `qorpera_list_cloud_routines` shows every routine's title and instructions to any
reader of the company, past the files' authority on folder-v2.
