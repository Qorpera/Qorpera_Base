# Company folder core: erasure (slice P18)

Status: design, for review (round 2). Owner: the folder GC and erasure session (slices P11, P12, P18; taken over from
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
- the bytes lose their roots and folder GC collects them, 24 hours or more after GC serves the company (§4.4).

A file's history can run through moves. Erasure covers whole histories, never part of one: the request is refused
unless its roots are **closed under moves** (§2.3), naming the paths to add or the live file a history continues in.

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

### 2.1 Deleted
A root is erasable when, under the request's locks (§3), it has no live entry. Then nothing under it is live either:
every write needs a live parent (`parent_missing`, 20260928259230:1299-1301).

### 2.2 As of the request
The request holds the root keys `FOR UPDATE` and every ancestor `FOR KEY SHARE` (§3), then reads the folder clock's
`last_seq` as `as_of_seq` and `clock_timestamp()` as `as_of_at`. Every commit that left a version at or under a root
reached it through one of: the root's lock (an ancestor `KEY SHARE`, a target `FOR UPDATE`), the root's entry row (a
subtree delete or move at an ancestor), or the root key's unique index (a move, copy or new folder at an ancestor), so
it committed before the request's locks and has `seq ≤ as_of_seq`; one that comes later waits on the claim and gets a
larger seq (review r1, "§2's seq argument holds"). Every version under the roots with commit seq ≤ `as_of_seq` is
erased. A path made again after the request is a new life: a write after a delete has no prior
(20260928120000:458), so it links nothing erased and stays.

No erased version is any entry's current version, and test 630's lost-versions invariant holds (review r1).

### 2.3 Closed under moves
A move writes a `move_out` at the source key and a `move_in` at the target, both with the source version as prior
(20260928120000:538-551). The request reads, through the version key index (§4.1), every `move_in` and `move_out`
row under the roots with seq ≤ `as_of_seq`, and their partners (the other row of the same `commit_id` and
`prior_version`):
- a `move_in` under a root whose `move_out` is outside every root: the file's earlier life is at that source path;
- a `move_out` under a root whose `move_in` is outside every root: its later life is at that target path.

If any partner lies outside the roots, the request is refused (22023) with up to 20 such paths and, for each, whether
it is live ("this file was moved to X, which is live; delete it first") or deleted ("this file's history continues
at X; add it"). The member adds them and asks again; the check repeats over the larger set. So a renamed-then-deleted
contact is erased whole, and the old name of a renamed live agent is refused. A copy (`copy`, prior null) starts its
own history and is not followed.

### 2.4 Refused roots
- under `agents/`, `rules/` or `tables/` until P18b (their index rows need §5's second table);
- `members/<id>/private/**`, except by that member: a private resource is its owner's alone (20260928249000:86-95);
- a root with no version at or below it ("nothing to erase");
- a root at or under an unrevoked path resource (`qorpera_company_path_resources`): the member revokes it first;
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
4. **Ranks 2, 4, 5.** §5's candidate rows in `qorpera_folder_structured_lock`'s table order (20260928429986:547-552),
   then id: `FOR UPDATE` for rows to delete, `FOR NO KEY UPDATE` for rows to update; each re-read after its lock.
5. **Paths.** Every root `FOR UPDATE` and every ancestor `FOR KEY SHARE`, claiming absent keys, in one `key_text
   collate "C"` order, through `qorpera_folder_lock_path`, as the commit locks a unit's paths
   (20260928259230:1051-1065). A live root refuses (22023).
6. **As of.** `as_of_seq` and `as_of_at` (§2.2). Then the candidate read of step 1 again: a retired row under a root
   that step 4 did not lock (a delete committed between step 1 and step 5) refuses with the conflict envelope (QRC01
   409; the member route asks again). §2.3's move check and §2.4's history and resource checks run now, under the
   locks.
7. **Writes.** §5's index rows; the erasure row (§4); the claims step 5 inserted are deleted. No clock lock, no journal
   row, no fence (member commits take none; core §9 "reads and GC never").

It returns `{erasureId, asOfSeq, roots: [{path, versions}]}`, the per-root count of versions to erase, so a mistyped
root shows as missing rather than completing silently (it is refused by §2.4 anyway).

## 4. The drain

### 4.1 Tables and indexes (P18a's migration)
- `qorpera_folder_erasures(id, environment_id → folder clock cascade, profile_id → profiles cascade, operation_key,
  request_sha256, requested_by_user_id, requested_at, as_of_seq, as_of_at, roots text[], state, counters, cursors,
  bytes_pending boolean, done_at)`; unique (environment_id, operation_key).
- `qorpera_folder_erasure_hashes(erasure_id → cascade, sha256)`: manifests and chunks whose roots the erasure ended,
  waiting for §4.4.
- Indexes: `qorpera_folder_path_versions (environment_id, (qorpera_folder_key(path)) collate "C")` (an expression
  index: no table rewrite); `qorpera_folder_file_chunks (profile_id, manifest_sha256)` (missing today, which the GC
  finish's cascade also needs); `qorpera_folder_commits (environment_id, created_at) where seq is null`.
- The expression index depends on the Unicode tables behind `qorpera_folder_key`: core §2's PostgreSQL upgrade step
  gains a `REINDEX` of it, like the generated keys.

### 4.2 Running it
`qorpera_folder_erasure_step(p_versions integer, p_commits integer, p_hashes integer)` does one bounded step in one
transaction (2 s lock budget): pick the oldest unfinished erasure by a plain read; take its company row `FOR KEY SHARE
SKIP LOCKED` (a company under purge is skipped: the purge cascades the erasure away); then the erasure row `FOR UPDATE
SKIP LOCKED`, re-read; leave if the company is being deleted. A procedure, `qorpera_folder_erasure_drain()`, calls
steps and commits between them for up to 50 seconds; pg_cron runs it every minute. A large agent folder (50,000
versions, 1,000 per step at about a second each) takes about a minute; the commit scan of a large environment takes
longer (§4.3), and status shows it.

`qorpera_folder_erasure_status(p_environment_id, p_actor, p_erasure_id)` (member route): state and counters per
phase, for the web's "Erase".

### 4.3 The phases of a step
After the erasure row, a step locks nothing but history rows nobody else locks (version deletes; commit `units`
updates, whose `FOR NO KEY UPDATE` never blocks foreign-key `KEY SHARE`) and, last, catalog rows `KEY SHARE` through
the side rows' foreign key. Phases run in order; each step works on the first unfinished one:
1. **Versions.** Up to `p_versions` rows under the roots with seq ≤ `as_of_seq`, by the key index; their manifests and
   chunks (by the new chunk index) go to the erasure's hash table; their distinct commit ids and written paths are
   noted (the needles of phase 2); the rows are deleted.
2. **Commits.** All of the environment's commits up to the request, with no lower bound: saved ones by `(environment_id,
   seq)` up to `as_of_seq`, unsaved ones by the new partial index up to `as_of_at`; `p_commits` per step, by cursor. In
   each unit:
   - `path` or `to` whose key is at or under a root becomes `""`, and that unit's `problems` are dropped (they may
     quote the file's content: the client parser's problems, 20260928259310:325-327);
   - in any other unit, a problem message containing a needle is blanked (`""`). Needles: every written spelling of an
     erased path, its first 100 characters (the rules quote `left(path, 100)`), and its file name without extension
     when it has at least 4 characters (the rules quote the stem, 20260928249020:155-156).
   The unit keeps `unit`, `op`, `outcome`, `reason` and `version`: the runtime's strict parser accepts it on replay
   (`cloud-company-folder-client.ts:474-497`), and run completion reads `outcome` (20260928279600:170).
3. **Outside the folder tables** (§6), by the same needles and cursor style.
4. **Bytes (C1D §9.4).** When the company is one folder GC serves, up to `p_hashes` of the hash table, in
   `sha256 collate "C"` order, in a statement after the deletes: upsert `qorpera_folder_object_gc(profile, hash,
   now())` with `greatest`, where a catalog row exists and `qorpera_folder_object_rooted` is false; the hash rows go.
   When it is not (a mixed company; folder GC switched off), the hashes stay and the erasure ends with `bytes_pending`;
   the drain revisits such erasures once an hour and enqueues them once folder GC serves the company.
   The shared helper also serves the git-object exception (core §2), the other pruner of versions.
5. **Done.** The roots are dropped from the row; the counts and the request digest stay.

## 5. Index rows

The request (§3 step 7) handles every retired or archived index row that meets all three: its folder key is at or
under a root; it is still retired; its retire commit (`folder_commit_id` or `commit_id`, which the retire writes,
20260928259310:1274, :1295) has seq ≤ `as_of_seq`. So no restore by id slips in between the request and the drain,
and a later life's row is never touched.

**P18a** (contacts, human tasks, connections):

| Index | On erasure |
| --- | --- |
| contact index | deleted (`FOR UPDATE` in step 4) |
| human-task index | deleted |
| connection index | deleted; the vault's secret and its grants are separate and stay |

A later file with the same id is a new contact, task or connection.

**P18b** (agent folders and rules; refused by P18a, §2.4). Each table gains `folder_erased_at`; each CHECK the
change meets gains `or folder_erased_at is not null`; content is replaced by a fixed placeholder that meets the
remaining checks (staff `charter`, room `purpose`, routine versions' `prompt`, rule `when_text`; review r1 §5 lists
each constraint). Path text and environment are cleared; bare version uuids (`folder_path_version`, room members'
`source_path_version`) are left dangling, as they name nothing once the row is erased. Staff's update bumps `version`,
as the retire does, and its operations trigger takes the company's operation clock after every rank, as in the
commit; `qorpera_company_operations`' earlier `staff_state` payloads of that agent (its charter history) are scrubbed
to the placeholder. An erased id never comes back: the rules refuse it ("outside the company folder",
20260928249020:468-469). Contract 14.1's dependent enforcement state goes with it: the agent's path grants, execution
authorities and connector and office grants are deleted. P18b states each of these as a decision for the coordinator.

When F2-5b lands, worker rows (`folder_brief_version`, `folder_results_version`) join; when P17 lands, conflict copies
on receipts are erased with their path; I6's interface and table indexes, H5's link and delivery rows and the C4
listener's file-change wakes join before they hold paths.

## 6. Outside the folder tables

| Copy | Proposal |
| --- | --- |
| `qorpera_run_operation_receipts.result` (tool output, up to 64 KiB) of the company's runs up to `as_of_at` | a result containing a needle is replaced by `{"erased": true}` |
| `qorpera_action_reviews.action` (a reviewed call's arguments) | the same |
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

- Request: owner and admin only; a member's own private path; a live root refused; a root inside another refused;
  `agents/`, `rules/` and `tables/` refused; a root with no history refused; an unrevoked resource refused; replay and
  a key reused with other paths; the claims gone afterwards; a company being deleted refused; a concurrent create
  under a root waits and becomes a new life the drain keeps; a retired row appearing between the candidate read and
  the path locks refuses with QRC01.
- Moves: a renamed-then-deleted contact refused naming its old path, then erased whole with it; the old name of a
  renamed live file refused; a copy not followed.
- Drain: every version of a deleted file and a deleted folder's subtree, keys deleted before the folder included; a
  later life kept; units scrubbed to the parser's shape (a replay parses), problems dropped or blanked by every needle
  form, a refused first save scrubbed; receipts and reviewed arguments scrubbed; side rows only for unrooted hashes of
  a served company; `bytes_pending` for a mixed company and its later enqueue; the step bounds; a company purged
  mid-erasure; status; the lock text (no fence, no clock, no profile row stronger than KEY SHARE, the 2 s budget) and
  the grants.
- Races (dblink): the request against a commit creating under a root and against a commit deleting a file under it;
  the drain against folder GC's claim and finish; the drain against the company purge (core §8's erasure race).
