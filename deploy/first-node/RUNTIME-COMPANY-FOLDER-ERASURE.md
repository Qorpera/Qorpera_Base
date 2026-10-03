# Company folder core: erasure (slice P18)

Status: design ratified 3 October 2026 (#732, §8's decisions as proposed); P18a built (§10); P18b built (§11). Owner: the folder GC and erasure session (slices P11, P12, P18; taken over from
F2 on 3 October 2026). Rules: contract 5.6 ("Permanent erasure"), 14.1 (an agent's permanent deletion), the
2026-10-02 amendment "work for people" item 3, core §8 ("Erasure"), C1D §9.4 (when a root ends). Evidence:
`~/work/qorpera-folder-core-tools/reports/P18-erasure-inventory.md` (every column, reader and lock erasure meets) and
`P18-design-review-r1.md` (round 1).

## 1. What erasure is, and what it leaves

An owner or admin purges one or more **deleted** paths of a folder-v2 environment (a contact's file, a human task's
folder, a deleted agent's folder, any deleted path; a folder covers every key under it). After it:
- every stored version of those keys up to the request is gone, with its parse (`structured`);
- the path names, and every problem text that quoted them or the files' content, are gone from change sets;
- the retired index rows built from those files are gone or carry no pointer and no copied content (§5);
- the bytes lose their roots and folder GC collects them, 24 hours or more after GC serves the company (§4.3, phase 5).

A key can hold several files over time: a write after a delete starts a new life with no prior
(20260928120000:458). Erasure removes **past lives**: a root that is live again (another contact saved at the same
path) has its earlier lives erased and its current life kept (§2.2). A file's history can also run through moves.
Erasure covers whole histories, never part of one: the request is refused unless its roots are **closed under moves**
(§2.3), naming the paths to add, or the live file a history continues in.

What stays, by decision (§8 lists them for the coordinator):

| Kept | Why |
| --- | --- |
| commit rows with actor, requester, approver, run and seq; the journal (seq, kind, commit id) | attribution (contract 5.6) |
| member ids in commits and folder reviews | attribution; accounts close, never erase (contract 14.1 as amended 28 Sep; 20260928249180:13-15) |
| run and view read records, with their paths | they drive live rechecks (20260928249000:662-672, :718-724); a run's audit, like its transcript |
| conversations, transcripts, memory and other files that name the person | free text; a member removes it (the amendment) |
| bytes shared with a path that is not erased (a copy, the same content elsewhere) | content addressing roots them there; a copy is its own history, erased by naming its path |

What is scrubbed beyond the folder tables (§6): tool results in receipts and reviewed calls' arguments that quote an
erased path or file. What must be clear before a root is accepted: no unrevoked path resource at or under it.

## 2. Which paths, and which versions

### 2.1 Past lives, and each root's cutoff
Version rows are ordered by their position `(seq, unit_no)`: a unit's rows all share one. Under the request's locks
(§3) each root gets a **cutoff position**; every row at or under the root strictly before it is erased:
- a root with no live entry: `(as_of_seq, +∞)` (below). Nothing under it is live either: every write needs a live
  parent (`parent_missing`, 20260928259230:1299-1301);
- a live root: the position of its current life's **start**, the latest row at the root's key that starts a life: a
  `write` or `mkdir` with a null prior, a `copy`, or a `move_in` whose `move_out` partner (§2.3) is at another key. A
  same-key move (a case-only rename writes a `move_out` and a `move_in` at one key in one unit, 20260928120000:538-557)
  continues the life, and so does a write with a prior (its prior is the same key). One indexed probe, newest first.
  Under the root's `FOR UPDATE` the current life cannot change. A live root with no row before its start refuses
  ("nothing to erase at X").

So a delete and a re-create in one change set split at the re-create's unit, and a case-renamed live file keeps its
whole history. Under a live folder root, its previous life (and every key under it) ended before its start; the keys
under it made since come after it. The current life's versions, and its live index row, stay.

### 2.2 As of the request
The request holds the root keys `FOR UPDATE` and every ancestor `FOR KEY SHARE` (§3), then reads the folder clock's
`last_seq` as `as_of_seq` and `clock_timestamp()` as `as_of_at`. Every commit that left a version at or under a root
reached it through one of: the root's lock (an ancestor `KEY SHARE`, a target `FOR UPDATE`), the root's entry row (a
subtree delete or move at an ancestor), or the root key's unique index (a move, copy or new folder at an ancestor), so
it committed before the request's locks and has `seq ≤ as_of_seq`; one that comes later waits on the claim and gets a
larger seq (review r1, "§2's seq argument holds"). Every version under a root before that root's cutoff (§2.1) is
erased. A path made again after the request is a new life: a write after a delete has no prior
(20260928120000:458), so it links nothing erased and stays.

No erased version is any entry's current version, and test 630's lost-versions invariant holds (review r1).

### 2.3 Closed under moves
A move writes a `move_out` at the source key and a `move_in` at the target, both with the source version as prior,
in one unit (20260928120000:538-551); a version is the prior of at most one move pair in a commit. The request reads,
in one set-based join through the version key index (§4.1), every `move_in` and `move_out` row under the roots before
the root's cutoff, and its partner: the row of the other move op with the same `(commit_id, unit_no,
prior_version)`. A partner is **open** when it is not under a root before that root's cutoff:
- a `move_in`'s open partner: the file's earlier life is at that source path;
- a `move_out`'s open partner: its later life is at that target path. When that target key is live and its current
  life's start (found as in §2.1) is this very `move_in`, the file was moved, not deleted: "this
  file was moved to X, which is live; delete it first". Otherwise the target holds a past life the member can add.

A partner already erased by an earlier erasure (no row) is closed. Subtree moves give each descendant its own pair;
a case-only rename keeps the key, so both rows lie under one root. The request follows the chain itself, adding each
open past-life partner's path to a working set until it is closed, and then, if the set grew, refuses (22023) listing
the topmost paths to add (up to 20) and any live continuation. The member asks again with them. So a
renamed-then-deleted contact is erased whole, and the old name of a renamed live agent is refused. A chain through
`agents/` cannot close until P18b. A copy (`copy`, prior null) starts its own history and is not followed: the request
answers a warning with the live paths whose versions share an erased manifest (by the manifest index), so the member
can erase copies too (the empty file's manifest is left out). The same manifest query lists deleted copies, as paths
the member may add.

### 2.4 Refused roots
- under `agents/`, `rules/` or `tables/` until P18b (their index rows need §5's second table);
- `members/<id>/private/**`, except by that member: a private resource is its owner's alone (20260928249000:86-95);
- an unrevoked path resource at or under a root (`qorpera_company_path_resources`): the member revokes it first;
- a seeded folder itself (`contacts`, `human-tasks`, `connections`, …): it is never deleted.

## 3. The request: one short transaction

`qorpera_folder_erase(p_environment_id uuid, p_actor jsonb, p_paths jsonb, p_operation_key text) returns jsonb`,
service role only. The member route calls it with the member actor, as for a member's commit (C4 builds the route; the
web's "Erase" is the Interfaces session's). In order:

1. **No locks.** Service role, read committed, a folder-v2 environment, a member actor, 1 to 20 valid paths, no root
   inside another, §2.4's path rules, the operation key. Replay: the erasure row of this (environment, key) answers
   when its request digest (actor, roots) matches, and 22023 when it does not, as the commit's key does
   (20260928259230:967-978). A concurrent duplicate waits on the root claims, then inserts its key `on conflict do
   nothing` and reads the replay. Candidates for §5: a plain read of the retired index rows under the roots.
2. **Rank 0.** The company row `FOR KEY SHARE`. A company being deleted refuses (55000).
3. **Rank 1.** The actor's member row `FOR KEY SHARE`; owner or admin (`qorpera_folder_mutator_role` and an explicit
   test), else 42501.
4. **Rank 5.** §5's contact and human-task candidates, in `qorpera_folder_structured_lock`'s table order
   (20260928429986:547-552), then id, `FOR UPDATE` (they are deleted); each re-read after its lock. These are the
   tables the commit locks at rank 5 too.
5. **Paths.** Every root `FOR UPDATE` and every ancestor `FOR KEY SHARE`, claiming absent keys, in one `key_text
   collate "C"` order, through `qorpera_folder_lock_path`, as the commit locks a unit's paths
   (20260928259230:1051-1065). A live root keeps its current life (§2.1).
6. **As of.** `as_of_seq` and `as_of_at` (§2.2), each root's cutoff (§2.1). Then the candidate read of step 1 again:
   a retired contact or task row under a root that step 4 did not lock (a delete committed between step 1 and step 5)
   refuses with the conflict envelope (QRC01 409; the member route asks again). §2.3's move check and §2.4's resource
   check run now, under the locks; the resource check applies to deleted roots only (a live root's resource governs
   its current file).
7. **Connection rows**, where the commit's apply takes them (after its paths; the connection index is no lock target,
   20260928249140:15-17): selected again now, under the three conditions, and locked `FOR UPDATE`. P18b's todos and rules go
   here too.
8. **Writes.** The erasure row and its needles (§4.1); §5's index rows; the claims step 5 inserted are deleted. No
   clock lock, no journal row, no fence (member commits take none; core §9 "reads and GC never").

It returns `{erasureId, asOfSeq, roots: [{path, cutoffSeq, cutoffUnit, versions}], copies: [{environmentId, path, live}]}`: the per-root count of versions
to erase, so a mistyped root shows as zero rather than completing silently (a root named only by refused saves has
zero versions and still has its units scrubbed), and §2.3's copy warning.

## 4. The drain

### 4.1 Tables and indexes (P18a's migration)
- `qorpera_folder_erasures(id, environment_id → folder clock cascade, profile_id → profiles cascade, operation_key,
  request_sha256, requested_by_user_id, requested_at, as_of_seq, as_of_at, roots jsonb ({key, cutoffSeq, cutoffUnit, cutoffAt}),
  state (`working`, `waiting`, `done`), revisit_at, counters, cursors, bytes_pending boolean, done_at)`; unique
  (environment_id, operation_key).
- `qorpera_folder_erasure_needles(erasure_id → cascade, needle, cutoff_seq, cutoff_unit, cutoff_at)`: each root's and
  each erased version's written path, and its first 100 characters, with the root's cutoff (phases 2 and 4).
- `qorpera_folder_erasure_runs(erasure_id → cascade, run_id, state)`: the runs phase 4 scrubs, kept while a run is
  live or a card open.
- `qorpera_folder_erasure_hashes(erasure_id → cascade, sha256)`: manifests and chunks whose roots the erasure ended,
  waiting for phase 5 (§4.3).
- Indexes: `qorpera_folder_path_versions (environment_id, (qorpera_folder_key(path)) collate "C")` (an expression
  index: no table rewrite); `qorpera_folder_file_chunks (profile_id, manifest_sha256)` (missing today, which the GC
  finish's cascade also needs); `qorpera_folder_commits (environment_id, created_at) where seq is null`;
  `qorpera_folder_run_read_records (environment_id, created_at)`; `qorpera_folder_erasures (state, revisit_at,
  requested_at) where done_at is null` (the idle check).
- The expression index depends on the Unicode tables behind `qorpera_folder_key`: core §2's PostgreSQL upgrade step
  gains a `REINDEX` of it, like the generated keys.

### 4.2 Running it
`qorpera_folder_erasure_step(p_versions integer, p_commits integer, p_hashes integer)` does one bounded step in one
transaction (2 s lock budget). Candidates, by a plain read in `requested_at` order: erasures in state `working` of
companies with no `qorpera_company_deletions` row (a company being deleted is purged with its erasures; one in
deletion for days never stalls the others), then erasures in state `waiting` (only pending runs or pending bytes left)
whose `revisit_at` has passed. A step that leaves an erasure `waiting` sets `revisit_at` an hour on. The partial index
is on `(state, revisit_at, requested_at) where done_at is null`. For each candidate in turn: its company
row `FOR KEY SHARE SKIP LOCKED` (the purge's `FOR UPDATE` makes it skip), then the erasure row `FOR UPDATE SKIP
LOCKED`, re-read; on a skip it goes to the next candidate (the skipped company's `KEY SHARE` is held to the end of the
step, which is harmless). pg_cron runs it every 5 seconds (`'5 seconds'`, one `select
public.qorpera_folder_erasure_step(1000, 1000, 2000)` per tick; no procedure, since one that commits can be neither
security definer nor carry `set`). Like the repo's other cron functions it checks no JWT role and is revoked from
`public, anon, authenticated, service_role` (20260930002600:141-197). Seconds schedules need pg_cron 1.5 or later
(checked in production before the cut). It writes about 17,000 `cron.job_run_details` rows a day; P18a's migration
schedules their cleanup (a daily delete of this job's rows older than a day), since `cron.log_run` is cluster-wide.
Both jobs follow the repo's optional-pg_cron pattern (20260930002600:199-225), so the migration applies where pg_cron
is absent. A large agent folder (50,000 versions, 1,000 per
step) takes about four minutes; the commit scan of a large environment takes longer (§4.3), and status shows it.

`qorpera_folder_erasure_status(p_environment_id, p_actor, p_erasure_id)` (service role, through the member route, for
the company's owners and admins): state and counters per phase, for the web's "Erase".

### 4.3 The phases of a step
After the erasure row, phases 1, 2, 3 and 5 lock nothing but history rows nobody else locks (version deletes; commit
`units` updates, whose `FOR NO KEY UPDATE` never blocks foreign-key `KEY SHARE`) and, last, catalog rows `KEY SHARE`
through the side rows' foreign key; phase 4's rows are run-owned and taken `SKIP LOCKED`. Phases run in order; each
step works on the first unfinished one:
1. **Versions.** Up to `p_versions` rows under each root before its cutoff, by the key index; their manifests and
   chunks (by the new chunk index) go to the erasure's hash table; their written paths go to the needles; the run ids
   of their commits are noted for phase 4; the first erased version's time is kept on the erasure row (phase 3's lower
   bound); the rows are deleted.
2. **Commits.** All of the environment's commits before each root's cutoff, with no lower bound: saved ones by
   `(environment_id, seq)` (the cutoff's own commit only in units before its unit), unsaved ones by the new partial
   index created before the cutoff's commit (`as_of_at` for a deleted root); `p_commits` per step, by cursor. In each
   unit:
   - `path` or `to` whose key is at or under a root becomes `""`, and that unit's `problems` are dropped (they may
     quote the file's content: the client parser's problems, 20260928259310:325-327);
   - in any other unit, a problem message containing a needle is blanked (`""`). Needles are paths only: every written
     spelling of an erased path and its first 100 characters (the rules quote `left(path, 100)`). A bare file stem
     would blank unrelated text, so it is not one.
   A commit whose units were scrubbed or blanked has its run noted for phase 4.
   The unit keeps `unit`, `op`, `outcome`, `reason` and `version`: the runtime's strict parser accepts it on replay
   (`cloud-company-folder-client.ts:474-497`), and run completion reads `outcome` (20260928279600:170).
3. **Runs that read.** The read records of the environment, by the new `(environment_id, created_at)` index from the
   first erased version's time to the cutoff's time, `p_commits` per step and at most 4 MiB of read records: a run is
   noted when one of its reads names an erased version.
4. **Outside the folder tables** (§6), over the noted runs only. One pass over them; a run still live, or with a card
   still open, stays `pending` in the runs table and does not hold the phases after it.
5. **Bytes (C1D §9.4).** When the company is one folder GC serves, up to `p_hashes` of the hash table, in
   `sha256 collate "C"` order, in a statement after the deletes: upsert `qorpera_folder_object_gc(profile, hash,
   now())` with `greatest`, where a catalog row exists and `qorpera_folder_object_rooted` is false; the hash rows go.
   When it is not (a mixed company; folder GC switched off), the hashes stay and the erasure waits with `bytes_pending`;
   the drain revisits such erasures once an hour and enqueues them once folder GC serves the company.
   The shared helper also serves the git-object exception (core §2), the other pruner of versions.
6. **Done**, once no noted run is pending and no byte is pending. Until then the erasure is revisited once an hour
   (pending runs and pending bytes alike), so one erasure waiting for a card nobody answers never holds up the
   others. The roots, the needles and the request digest are dropped from the row; the counts stay. A replay of
   the key after `done` answers the stored outcome without comparing paths.

## 5. Index rows

The request (§3 steps 4, 7 and 8) handles every retired or archived index row that meets all three: its folder key is at or
under a root; it is still retired; its retire commit (`folder_commit_id` or `commit_id`, which the retire writes,
20260928259310:1274, :1295) has seq at most the root's cutoff seq (an index row records the retiring commit, not its
unit; a retired row is never the current life's, so the cutoff's own commit counts). A live root's current row is
never a candidate. So no restore by id slips in between the request and the drain,
and a later life's row is never touched.

**P18a** (contacts, human tasks, connections):

| Index | On erasure |
| --- | --- |
| contact index | deleted (`FOR UPDATE` in step 4) |
| human-task index | deleted (step 4) |
| connection index | deleted (step 7); the vault's secret and its grants are separate and stay |

A later file with the same id is a new contact, task or connection.

**P18b** (agent folders and rules; refused by P18a, §2.4). Each table gains `folder_erased_at`; each CHECK the
change meets gains `or folder_erased_at is not null`; content is replaced by a fixed placeholder that meets the
remaining checks (staff `charter`, room `purpose`, routine versions' `prompt`, rule `when_text`; review r1 §5 lists
each constraint). Path text and environment are cleared; bare version uuids (`folder_path_version`, room members'
`source_path_version`) are left dangling, as they name nothing once the row is erased. Staff's update bumps `version`,
as the retire does, and its operations trigger takes the company's operation clock after every rank, as in the
commit; `qorpera_company_operations`' earlier `staff_state` payloads of that agent (its charter history) are scrubbed
to the placeholder, and their `content_sha256` recomputed. An erased id never comes back: the rules refuse it ("outside the company folder",
20260928249020:468-469). Contract 14.1's dependent enforcement state goes with it: the agent's path grants, execution
authorities and connector and office grants are deleted, the path grants through the authority journal
(`qorpera_folder_authority_journal`, so live runs' rechecks see them go: grants at rank 7 and the clock last, so P18b,
unlike P18a, writes a journal row). P18b's per-move-unit check of §2.3 and its
lock placement (todos and rules after the paths, step 7) follow this design. P18b states each of these as a decision
for the coordinator.

When F2-5b lands, worker rows (`folder_brief_version`, `folder_results_version`) join; when P17 lands, conflict copies
on receipts are erased with their path; I6's interface and table indexes, H5's link and delivery rows and the C4
listener's file-change wakes join before they hold paths.

## 6. Outside the folder tables

Rows are run-owned: phase 4 takes them `FOR NO KEY UPDATE SKIP LOCKED` and leaves a locked one for a later step. Each
step reads at most 4 MiB of results. A noted run still live, or with a card still open, stays `pending` in the
erasure's run table and is revisited hourly; status shows them, and the erasure is `done` only when none is left.

| Copy | Proposal |
| --- | --- |
| `qorpera_run_operation_receipts.result` (tool output, up to 64 KiB) | for the noted runs (phases 1–3: the runs that wrote, refused, were refused about, or read an erased path) once they have ended: a completed result created before a needle's cutoff time whose JSON text contains that needle (JSON-escaped) keeps its envelope (`schema`, `inputSha256`) and its `content` becomes `{"kind":"text","value":"[erased]"}`, which the runtime's replay check accepts (`cloud-native-tool-operations.ts:298-311`) |
| `qorpera_action_reviews.action` and `reason` | of the same runs, cards answered or consumed only (an open card is what the member is shown, 20260926210000:40-49), under the same needle and time rule: the card's `title`, `target`, `details` and `arguments` containing a needle become a placeholder ("Erased.", `{}` for arguments), and `reason` "Erased." |
| company mail rows (H4: outbox and received mail to or from a contact) | H4's owner adds them to this table before H4 sends to a contact |
| path resources and grants at or under a root | refused by §2.4 (revoke first) |
| journal `authority.changes[].prefix`, `qorpera_folder_authority_changes.prefix` | kept: they exist only where a resource was, which §2.4 requires revoked; the prefix of a revoked resource is attribution of that change |

## 7. Member ids

Commits keep `actor_id`, `requester_id` and `approver_user_id`, and folder reviews keep `answered_by_user_id`, as bare
uuids. Erasure keeps them as attribution (contract 5.6). For a member's own account, contract 14.1 (as amended
28 September 2026) closes an account and never erases it, because company records keep naming former members; a hard
delete is refused in practice by older links the structured-file hook writes (20260928249180:1-25). No schema change:
`SET NULL` links would meet the CHECKs that require them (20260928120000:132, 20260928200000:277).

## 8. For the coordinator

1. §1's "kept" table, §6's table (scrub receipts and reviewed arguments; H4's mail rows are its owner's), §7.
2. §5's P18a table, and P18b's direction (placeholders, no restore, the 14.1 cascade).
3. The split: **P18a** (migration slot 20260930009200, tests 883, 884) = §2–§4, §5's P18a table, §6's first two
   rows; **P18b** = agent folders and rules.

## 9. Tests (P18a)

- Request: owner and admin only; a member's own private path; a root inside another refused; `agents/`, `rules/`
  and `tables/` refused; a live root with no past life refused; an unrevoked resource at or under a
  deleted root refused (the environment's root resource never refuses; a live root's own resource never refuses);
  replay (also after `done`) and
  a key reused with other paths; the claims gone afterwards; a company being deleted refused; a concurrent create
  under a root waits and becomes a new life the drain keeps; a retired row appearing between the candidate read and
  the path locks refuses with QRC01.
- Lives: a contact path reused by another live contact: the first contact's versions erased, the live one's kept,
  with its index row and its units; a case-renamed live contact keeps its whole history (nothing to erase); a delete
  and re-create of one path in one change set splits at the re-create's unit; a live folder root keeps its current
  descendants.
- Moves: a renamed-then-deleted contact refused naming its old path, then erased whole with it; the same where the old
  path now holds another live file (a past life added, not refused as live); the old name of a renamed live file
  refused; a subtree move and a case-only rename; a partner erased earlier counts as closed; a copy warned about, not
  followed.
- Drain: every version of a deleted file and a deleted folder's subtree, keys deleted before the folder included; a
  later life kept; units scrubbed to the parser's shape (a replay parses), problems dropped or blanked by every needle
  form, a refused first save scrubbed, a stem alone never blanks; receipts of ended runs scrubbed keeping the envelope
  (a replay parses), a live run's and an open card's left; side rows only for unrooted hashes of
  a served company; `bytes_pending` for a mixed company and its later enqueue; the step bounds; a company purged
  mid-erasure; status; the lock text (no fence, no clock, no profile row stronger than KEY SHARE, the 2 s budget) and
  the grants.
- Races (dblink): the request against a commit creating under a root, against a commit deleting a file under it, and
  against the vault writing a connection file at a root;
  the drain against folder GC's claim and finish; the drain against the company purge (core §8's erasure race).

## 10. Built (P18a, migration 20260930009200, tests 883 and 884)

- **The request** `qorpera_folder_erase(environment, actor, paths, operation_key)` follows §3 step by step.
  - The owner-or-admin check is a plain read before any lock (and before a replay answers). It is checked again under
    rank 1.
  - It refuses `agents/`, `rules/` and `tables/` (0A000) until P18b. It refuses another member's `members/<id>/private`
    subtree, and any root above it.
  - A history that runs on at other paths is refused with 22023 and a detail `{add, live}`: the topmost paths to add
    (at most 20), and any live file the history moved into, including a file in a named live root's current life.
  - The reply is `qorpera.folder-erasure/v1`: `erasureId`, `asOfSeq`, and each root's count of versions. Its `copies`
    are up to 20 other paths, live or deleted, in any folder-v2 environment of the company, whose versions hold an
    erased manifest.
  - The erasure row is inserted `on conflict do nothing`. A request with the same key that committed while this one
    waited on the roots answers with its reply, and this one's claims go.
- **Every version search writes the key range out:** `key >= root and key < root || '0'`, then
  `qorpera_folder_erasure_covers`. A SQL function with `SET` is never inlined, so the range is the only way the new
  key index serves the search. This covers the count, the move check, the copies and phase 1. 883 checks the plan and
  each function's body.
- **The drain** `qorpera_folder_erasure_step(p_versions 1000, p_commits 1000, p_hashes 2000)` does one step of one
  erasure per call, in the phases of §4.3.
  - **Bounds:** each step works for about a second at most and reads at most 4 MiB of text, checked between rows. It
    goes on from its cursor next time. In phase 4 the cursor holds the run in progress: where its receipts stopped,
    and what they left.
  - **Needles** are a few per root: the root as named, and as each erased version spells the root's part of its path,
    with their first 100 characters. A needle matches only as a whole path or path prefix, so `docs/f` never matches
    `docs/finance.md`.
  - **Phase 4** tests each text against each needle with that needle's own cutoff time, so a live root's current life
    keeps its receipts and cards.
  - **Errors:** an error other than a lock wait records `last_error` and leaves the erasure waiting an hour, so it never
    holds up the others. A lock wait undoes the step, and the next tick goes on.
  - **Waiting:** an erasure left only with live runs, or with bytes GC does not take yet, is `waiting` and is looked at
    again an hour later. Bytes GC does take keep it working.
  - **Done:** a `done` erasure keeps its counts and no path. Its roots, needles and request digest go, and its stored
    reply loses `roots` and `copies` (a replay answers that).
  - `qorpera_schedule_folder_erasure()` asks pg_cron for the 5-second job and its daily log cleanup. With no pg_cron
    (1.5 or later) the migration still applies, with a notice.
- **Status** `qorpera_folder_erasure_status(environment, actor, erasure_id)` answers owners and admins, with
  `lastError`.
- **Inert** until the member route (C4) calls the request: nothing makes an erasure before that.
- **Tests:**
  - 883 covers:
    - refusals, with messages;
    - a deleted contact with its index row, change sets and bytes;
    - lives at a path: a reused path, a case-only rename, a split change set, a live folder root, and a contact deleted
      and saved again in one change set, keeping the live row;
    - histories through moves: a moved folder, a reused path's past life added, a partner already gone, a partner in a
      named root's current life;
    - the units scrub;
    - status, grants and the lock text;
    - path permissions; a company being deleted; connection rows; copies, live and deleted, with no side row for bytes
      a copy roots;
    - the step's bound; a failing step; the key index.
  - 884 covers, over dblink:
    - a request waiting for a commit that holds its root;
    - a commit creating a held root;
    - the drain skipping a company its purge holds;
    - receipts and reviewed cards of a run that wrote and of a run that only read, in a request mixing a deleted and a
      live root;
    - two requests with one key;
    - a run with more than 4 MiB of receipts, finished over several steps.
- **§9 cases with no test yet:**
  - the QRC01 re-read (a contact or task row retired between the request's first read and its path locks), before C4
    wires the member route;
  - the vault writing a connection file at a root during a request, also before C4;
  - the drain against folder GC's claim and finish, before the GC switch goes on.
  The first needs a committed fixture with contacts, which 884's fixture lacks.
- **Two behaviours for the member route** (P18a review r2):
  - A refusal's `live` list can name a move partner that has since moved on, such as a file moved out of a named live
    root's current life. The way out is to drop that root from the request, name the other path, and erase the root
    on its own.
  - A needle also matches a name that goes on after a space or other punctuation (`docs/f notes.md`, `docs/f(1).md`).
    That only scrubs more text, never less.

## 11. Built (P18b, migration 20260930009300, test 885)

Decisions (coordinator, 3 October 2026, as proposed):
- speaker names on past messages stay, like transcripts;
- `staff_state` and `session_state` rows in the operations log are scrubbed to the placeholders, and each changed row's
  `content_sha256` is recomputed from its own fields. Rows are not chained: the hash covers the row's type, entity,
  version and payload, and substrate versions bind only a sequence number. 885 checks every row's hash after the drain;
- office access and browser grants are revoked (state `revoked`), not deleted: screens point at them.

What it does:
- **The request** no longer refuses `agents/` and `rules/`; `tables/` waits for I6.
- **Locks:** it takes the commit's own locks in its rank order:
  - rank 2: the retired agents under the roots, NO KEY UPDATE (`qorpera_folder_structured_lock`);
  - rank 3: their execution authorities, FOR UPDATE (`qorpera_folder_lock_commit_rank`);
  - rank 4: the retired group chats and the agents' threads;
  - rank 5: the retired routines, FOR UPDATE (their tombstone key changes);
  - then P18a's task and contact rows;
  - ranks 6 and 7: the resources of the agents' live path grants, and the grants;
  - rank 8: their connector grants;
  - rank 11: the chats' sessions;
  - the paths;
  - after the paths, as the commit's apply takes them: the retired todos and rules, and the routines' versions.
- **Which rows:** a row is erased when its retire commit lies at or before its root's cutoff, as P18a's index rows are.
  A row that retired under a root between the first plain read and its lock answers QRC01.
- **Placeholders:**
  - agent: `Erased agent` / `Erased` / `Erased.`, version bumped;
  - group chat: `Erased group chat` / `Erased.`, no subtitle;
  - an agent's thread and the chats' sessions: renamed;
  - todo: `Erased`, empty detail, key `erased.<id>`;
  - routine: key `erased.<id>`; each version gets `Erased` / `Erased.` and its hash recomputed;
  - rule: `Erased.`.
  Each erased row also gets `folder_erased_at`, and its path and environment are cleared. Bare version and commit ids
  stay. Each check those rows meet gains its own branch for an erased row. An erased id never comes back: each kind's
  rule refuses an id whose row is outside the folder, and 885 checks all five kinds.
- **Contract 14.1:** the execution authority and the connector grants are deleted. The path grants are revoked through
  `qorpera_folder_authority_journal`, as the folder clock is taken last, so live runs' rechecks see them go.
- **The thread trigger** leaves an erased agent's thread to the erasure. Otherwise its own rename would re-add members
  and append a second title.
- **The drain's phase 6:**
  - It walks the company's operations log by sequence, 5,000 a step, up to where the log stood at the request, and
    scrubs the earlier names, charters and chat titles.
  - It then revokes the office access and browser grants, SKIP LOCKED. A row in use leaves the erasure waiting an hour.
  - Phase 7 is P18a's old phase 6.
- **P18a review r2 nits:** the card loop has its own cursor and budget check, a failing step raises a warning, and 883
  counts the key ranges in each function.
- **Not tested yet:** P18b's request against a concurrent commit that restores or edits an agent, a chat or a routine
  under a root, or that revokes its grants. As with P18a's §10 list, this comes before C4 wires the member route.
