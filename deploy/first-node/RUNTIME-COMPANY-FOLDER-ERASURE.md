# Company folder core: erasure (slice P18)

Status: design, for review. Owner: the folder GC and erasure session (slices P11, P12, P18; taken over from F2 on
3 October 2026). Rules: contract 5.6 ("Permanent erasure"), the 2026-10-02 amendment "work for people" item 3, core §8
("Erasure"), C1D §9.4 (when a root ends). The inventory behind it (every column, reader and lock it meets, with file and
line) is `~/work/qorpera-folder-core-tools/reports/P18-erasure-inventory.md`.

## 1. What erasure is

An owner or admin purges one or more **deleted** paths of a folder-v2 environment: a deleted agent's folder
(`agents/<name>/`), a contact's file (`contacts/<contact>.md`), a human task's folder, or any other deleted path. A
folder covers every key under it. After it:
- every stored version of those keys up to the request is gone, with its parse (`structured`);
- the path names are gone from the change sets that touched them (`units`), and from refusals that quoted them;
- the retired index rows built from those files keep no pointer to them, and the personal content they copied is gone
  (§5);
- the bytes lose their roots, and folder GC collects them (C1D §9; slice P11) once nothing else names them.

What stays (contract 5.6: "receipts and audit records keep their attribution"): commit rows with their actor,
requester, approver, run and seq; the journal; receipts; conversations and transcripts; read records' digests. Free
text elsewhere that names the person (other files, task titles, `## History` lines, memory, transcripts) is out of
reach, as the amendment says: a member removes it, and the writing skill names contacts by id only.

Bytes shared with a path that is not erased (a copy, the same content written elsewhere) stay, and stay readable
through that path: content addressing roots them there. Erasing a contact whose file was copied means erasing the copy
too.

## 2. "Deleted", and which versions go

- A root path is erasable when, under the request's lock on its key (§3), it has **no live entry**. Then no key under it
  is live either: every live entry has live ancestors.
- The request reads the folder clock's `last_seq` **after** it holds the root keys, as `as_of_seq`. Every commit that
  touched a key under a held root has committed by then (each held the root `FOR KEY SHARE` as an ancestor, or `FOR
  UPDATE` as a target), so its seq is at most `as_of_seq`.
- The erasure removes every version row whose key is a root or lies under one and whose commit's seq is at most
  `as_of_seq`. A path made again after the request is a new life: its versions have later seqs and stay. A write after a
  delete has no `prior_version` (`qorpera_folder_apply_unit`, 20260928120000:458), so the new life links nothing erased.
- So no erased version is any entry's current version (the live-version readers of the inventory §4b never meet a
  missing row), and test 630's "lost versions" invariant still holds: the rows that stay are live or some row's prior.
- A `move_in` elsewhere whose `prior_version` was erased keeps a dangling uuid. The feed already answers it as a hidden
  prior for members and runs (20260928237000:126-129).

## 3. The request: one short transaction

`qorpera_folder_erase(p_environment_id uuid, p_actor jsonb, p_paths jsonb, p_operation_key text) returns jsonb`,
service role only. The member route calls it with the member actor, as for a member's commit (C4 builds the route; the
web's "Erase" is the Interfaces session's).

1. Checks before any lock: service role, read committed, a folder-v2 environment, a member actor, 1 to 20 valid paths
   (no root inside another), the operation key. A replay of the key returns the erasure it recorded.
2. The company row `FOR KEY SHARE` (rank 0); the actor's member row `FOR KEY SHARE` (rank 1), whose role must be owner
   or admin (`qorpera_folder_mutator_role` with an explicit test), else 42501. A company being deleted refuses (55000):
   its purge removes everything.
3. Each root key in `key_text collate "C"` order: `qorpera_folder_lock_path(…, 'update')`, which claims an absent key.
   A live entry refuses with 22023 "path is not deleted". A concurrent commit that would create anything under a held
   root waits on the claim (it takes its ancestors), and one in flight is waited out.
4. `as_of_seq` := the clock's `last_seq`, a plain read (§2). The erasure takes no clock lock and writes no journal row.
5. The erasure row: `qorpera_folder_erasures(id, environment_id, profile_id, operation_key, requested_by_user_id,
   requested_at, as_of_seq, roots text[] (the folded keys), state 'pending', counters, cursors, done_at)`. Its foreign
   keys are the folder clock (cascade) and the profile (cascade, so the purge removes it).
6. The claims this call inserted are deleted (a claim never outlives its transaction), and it returns `{erasureId,
   asOfSeq, state}`.

The lock budget is 2 s per wait; nothing here is heavier than a one-unit member commit.

## 4. The drain: small batches

`qorpera_folder_erasure_step(p_limit integer)`, service role, run by pg_cron every minute (and by tests). Each call
works on the oldest pending erasure it can lock (`FOR UPDATE SKIP LOCKED`), in one transaction, with the 2 s budget:

1. **Versions.** Up to `p_limit` (default 1,000) version rows under the roots with commit seq at most `as_of_seq`, by an
   expression index `(environment_id, qorpera_folder_key(path) collate "C")` on `qorpera_folder_path_versions` (it has
   no key text today; an index, not a stored column, so the table is not rewritten). It collects their manifests `M`
   and chunk closures `C` (`qorpera_folder_file_chunks`), the distinct commit ids, and then deletes the rows. Nothing
   references a version row by foreign key, and no trigger runs.
2. **Units.** For each of those commits, each unit whose `path` or `to` has a key at or under a root gets that value set
   to `""`, and any `problems` item whose message contains an erased path loses its message (`""`). The unit keeps
   `unit`, `op`, `outcome`, `reason` and `version`, which is the shape the runtime's strict parser accepts on a replay
   (`cloud-company-folder-client.ts:476-498`), and what run completion reads (`outcome`).
3. **Quoted paths elsewhere.** Commits that never saved (seq null) and refusals of other saves quote paths too. A
   second cursor walks the environment's commits created from the first erased version's time up to the request, by a
   new index `(environment_id, created_at, id)`, `p_limit` per call, and scrubs them the same way.
4. **Roots end (C1D §9.4).** In a statement after the deletes, for each hash of `M ∪ C` in `sha256 collate "C"` order,
   when the company is one folder GC serves: upsert `qorpera_folder_object_gc(profile, hash, now())` with `greatest`,
   where a catalog row exists and `qorpera_folder_object_rooted` is false. The claim checks the roots again before any
   mark. The helper is shared with the git-object exception (core §2), the other pruner of versions.
5. **Index rows**, once the versions are gone (§5).
6. The counters and cursors move; when nothing is left the erasure is `done`, and its `roots` are replaced by their
   digests, so the request itself keeps no path name.

Locks, in the commit's order (core §3 step 4): the erasure row first (its own, as an operation key is); the company row
`FOR KEY SHARE` (rank 0); retired index rows `FOR NO KEY UPDATE` by rank, table and id (2 staff, 4 rooms and room
members, 5 the other indexes); then history rows nobody else locks (the version deletes, the commits' `units` updates,
whose `FOR NO KEY UPDATE` never blocks the `KEY SHARE` of foreign-key inserts); the catalog rows `KEY SHARE` through
the side rows' foreign key last. No fence, no clock, no profile row stronger than `KEY SHARE`. A company being deleted
stops the drain (`cancelled`). Each step is bounded, so one erasure of a large agent folder takes a few minutes of
one-second steps, never one long transaction.

## 5. Retired index rows

The structured-file indexes keep a row for a deleted file (retired, archived) with its path, version and commit, which
the "restore compares with the last file" rules read. Their CHECKs and NOT NULLs forbid clearing those pointers today
(inventory §1b). Proposed:

| Index (file) | On erasure | Why |
| --- | --- | --- |
| contact index (`contacts/*.md`) | the retired row is deleted | its path is the person's name; a later file with that id is a new contact |
| human-task index (`human-tasks/*.md`) | the retired row is deleted | it copies the title and names the contact |
| connection index (`connections/*.md`) | the retired row is deleted | a descriptor only; the vault's secret is separate |
| staff (`agents/<a>/agent.md`) | pointers cleared, `folder_erased_at` set; `charter` emptied; name and role kept | conversations and runs show the agent by name (attribution) |
| rooms (`agents/groups/<g>/group.md`) | pointers cleared, `folder_erased_at`; `purpose` emptied; name kept; room members' `source_path_version` cleared | as staff |
| todos, routines (and their versions), rules | pointers cleared, `folder_erased_at`; `detail`, prompts and rule text emptied; titles kept | as staff |

For the last three groups each table gains `folder_erased_at` and its coupling CHECK gains "or erased". An erased row
can never come back: a later file with its id is refused, as one "outside the company folder" (20260928249020:468-469).
That is what erasure means. Staff updates run their row triggers (the deleted-row guard, the writer guard); the drain
changes only `folder_*` columns and `charter`, as the commit's hook does.

When F2-5b lands, worker rows (`folder_brief_version`, `folder_results_version`) join the table above; when P17 lands,
conflict copies on receipts are erased with their path and stop rooting their bytes.

## 6. Read records

Run and view read records keep `{path, version, fileSha256}` per read (`qorpera_folder_run_read_records.reads`). They
are a run's audit of what it read, like a receipt. Proposed: kept, with their paths, as the receipts and transcripts of
those runs are. Alternative: the drain also scrubs `path` in read records of the environment's runs created in the
window (one more cursor).

## 7. Member ids

Commits keep `actor_id`, `requester_id` and `approver_user_id`, and folder reviews keep `answered_by_user_id`, as bare
uuids. Erasure of a path keeps them: they are attribution (contract 5.6). For a member's own account, the stated policy
is a close (Supabase soft delete), never an erase (20260928249180:1-25), and a hard delete is refused in practice by the
older links the structured-file hook writes (staff `updated_by_user_id`, rooms, sessions, routines, resources). So
folder-core member ids stay as pseudonymous attribution after a close. No schema change is proposed. Adding `SET NULL`
links would collide with the CHECKs that require them (20260928120000:132, 20260928200000:277).

## 8. Open points for the coordinator

1. §5's table: delete the contact, human-task and connection index rows; clear and mark the others; no restore of an
   erased agent, group, todo, routine or rule.
2. §6: keep read records' paths, or scrub them.
3. §7: member ids stay as attribution, no schema change.
4. Split: **P18a** = §3, §4 steps 1–4 and 6, and §5's first three rows (what contacts and human tasks need before H5
   sends any link); **P18b** = §5's other rows (agent folders); **P18c** = §6 if chosen.

## 9. Tests (per slice)

- Request: owner and admin only; a live path refused; a root inside another refused; replay; claims gone afterwards; a
  company being deleted refused; a concurrent create under the root waits for the request and then makes a new life the
  drain keeps.
- Drain: every version of a deleted file and of a deleted folder's subtree erased, including keys deleted before the
  folder; a key made again after the request kept; a moved-away key's `move_out` rows erased and the destination's
  versions kept; units and quoted refusals scrubbed to the parser's shape, and a replay of an erased commit's key parses;
  run completion unaffected; side rows written for unrooted manifests and chunks only, not for bytes another path
  roots, not for a mixed or deleting company; the batch bound; a company deleted mid-erasure; the lock text (no fence,
  no clock, no profile row stronger than KEY SHARE, the 2 s budget) and the grants.
- Races (dblink): the request against a commit creating under the root; the drain against a commit restoring the same
  key; the drain against folder GC's claim of an object it just unrooted (core §8's "erasure" race).
- Index rows: each row of §5's table, and a later save with an erased id refused.
