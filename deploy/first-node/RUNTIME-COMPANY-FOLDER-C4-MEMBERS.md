# The company folder for members: reads, history and the hint (C4, P27 and P30)

Part of [the company folder core](RUNTIME-COMPANY-FOLDER-CORE.md), §6 ("Clients") and §11 C4: "the members' and
clients' hint" and the member routes. Slices P27 and P30 of the folder core plan (coordinator audit, 2 October 2026),
moved from F3 to the Interfaces session on 3 October 2026. The web file page and history on folder-v2 (P33) are built
on them. Member writes stay held until human-task wakes run on the listener (P31).

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
  call instead of an Edge Function, the gateway and two database calls. Writes will need the gateway (uploads and
  their intents), and get it with P31.
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
  it the member may read (`path`, `op`, `kind`, `version`), at most 20, with `more` when the change set has others
  they may read or more than the call examined. A change set with no readable path is left out, and so are
  authority rows. Work per call is bounded: at most `p_limit` change sets, and 200 path versions of each, are
  examined. `p_before` and `next` are a seq.
- **`by`:** `{kind: "member", userId}`, `{kind: "agent", staffAgentId, requesterUserId}` or `{kind: "platform"}`,
  from the commit's attribution columns. The client shows names from the members and agents it already has.

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
| P27a | the caller check; the five member functions; history | `20260930013000`, SQL tests 833 (reads, list, bytes check), 834 (history, changes) |
| P27b | the object gateway's member folder route and the member company gateway's route; cloud-client's member folder client (parsers tested against real SQL output) | none |
| P30 | the hint trigger, topic and policy; cloud-client's hint subscription | `20260930013100`, SQL test 835 |
| P33 | the web file page and history on folder-v2 | none |

Each is inert until a folder-v2 company exists.
