# Restore of a repository kept in Qorpera (operator's runbook)

A repository kept in Qorpera lives in its company's folder at `code/<owner>/<name>/`. Nightly care copies it out
as a git bundle of every ref, with a manifest, to the coding executor's storage
(`packages/runner-orchestrator/src/code-bundle-store.ts`). This runbook puts one back
(`packages/runner-orchestrator/src/code-host-restore.ts`; own code storage, step 2b).

Only an operator starts a restore, with one SQL call as the database owner. No agent or member can.

**Do not use it on a real repository before the drill at the end has passed on a throwaway one.** Until then, the
"By hand" section is the way back.

## 1. What a restore does

Words: the **place** is the folder `code/<owner>/<name>/`. The **mark** is the file `restoring.json` in it. The
**set-aside copy** is what the place held, moved to `code/_set-aside/<owner>/at-<UTC>/<name>/`.

A restore never repairs in place and never deletes what it found. Its steps, each a job of its own on the
company's code host:

1. **Close.** The bundle is proven: its bytes are the manifest's (SHA-256 and size), git verifies it, every ref is
   fetched into an empty repository, the refs are the manifest's, `git fsck --full` passes, and the folder can hold
   it. Only then is the mark written. While the mark is there, every coding turn on the repository fails with "The
   repository is being restored from its copy", and nothing else touches the place.
2. **Set aside.** Everything in the place but the mark is moved, as it is, to the set-aside copy. A second job
   looks again and writes into the mark that the place is empty.
3. **Build.** The bundle is proven again. `repo.git` is made from it: the objects, every ref, then `main` and
   `main/` together.
4. **Open.** A job of its own checks that the place holds exactly the bundle's repository, and removes the mark.
5. Only with `remove`: the set-aside copy is removed, after the place is open again.

Three modes:

- `verify`: step 1's proof alone. It writes nothing in the company's folder.
- `restore`: all of the above, from a stored bundle's name, or from `fresh`.
- `discard`: removes one set-aside copy.

`fresh` first takes a new bundle of the place as it stands and stores it like a nightly one. When that works, the
history is sound and no change is lost. When it fails, the history itself is damaged: use a stored bundle.

What a restore brings back, and what not:

| | |
|---|---|
| Main | The bundle's main. With `fresh` that is main as it was. With an older bundle, the changes after it are gone from main; their records say `lost`. |
| Sessions' branches | As the bundle has them. |
| Sessions' worktrees | Not restored. A session's next turn gets a new worktree from its branch. |
| Files a session had not committed, and commits on no branch | Not in any bundle. They are in the set-aside copy. |
| The change record's files, downloads | Written again from the database, a little later. A download is asked for again. |
| The damaged place | The set-aside copy, until a `discard`. Members can read it in Storage; only the platform writes there. |

## 2. Before you start

1. Find the repository and how it stands:
   ```sql
   select environment_id, owner, name, problem, problem_since, main_sha, last_main, last_change,
          bundle_name, bundle_at, fsck_state
   from public.qorpera_code_repositories where profile_id = '<company id>';
   ```
2. List the stored bundles, on the node whose coding executor holds the company:
   `ls <executor storage>/control/code-bundles/<company id>/<owner>/<name>/`.
   Each bundle is `<UTC time>-<main, 12 hex>.bundle` with its manifest `.json` beside it. A bundle's **name** is the
   file's name without `.bundle`. The newest is last.
3. See which sessions are open on it:
   ```sql
   select worker_id, phase, attached_machine_id from public.qorpera_coding_sessions
   where environment_id = '<environment>' and repository ->> 'owner' = '<owner>'
     and repository ->> 'name' = '<name>' and archived_at is null;
   ```
   A restore does not start while the company's sessions are working, or while one of this repository's sessions is
   attached to a machine. Wait until their machines sleep (ten quiet minutes), or archive those sessions.

## 3. A restore

1. Try `fresh` first, unless the place is gone:
   ```sql
   select public.qorpera_request_code_restore('<environment>', '<owner>', '<name>',
     'restore', 'fresh', 'keep', '<why, one line>');
   ```
   It answers the request's id. `keep` keeps the set-aside copy; `remove` removes it once the repository is built
   and open again. Use `keep` unless you are sure nobody needs what was there.
2. Watch the request:
   ```sql
   select state, progress, outcome, attempts, not_before from public.qorpera_code_requests where id = '<request id>';
   ```
   - `queued` with `progress` `{"waiting": ...}`: sessions are working or attached. It starts by itself when they
     are not.
   - `running`: `progress.step` says which step: `fresh`, `close`, `set-aside`, `build`, `open`, `discard`.
   - `queued` again with `not_before`: a turn came first. It goes on in two minutes, from where it was. If nothing
     had been moved yet, the place was opened again meanwhile. Once the restore has begun to move the place
     (`progress.step` is `set-aside`, `build` or `open`, or `progress` has `setAside`), it is not put off for the
     company's sessions any more: the place is closed to them, the request is handed out again whatever they do, and
     its jobs keep their place in the company's line until the repository is open again.
   - `done`, outcome `restored`: go to step 4.
   - `failed`: go to section 4.
3. `failed` with `FRESH_BUNDLE_FAILED:...`: nothing was touched. The history is damaged, or the place is gone
   (`AREA_ABSENT`). Prove the newest stored bundle, then restore from it:
   ```sql
   select public.qorpera_request_code_restore('<environment>', '<owner>', '<name>', 'verify', '<bundle name>', null, null);
   select public.qorpera_request_code_restore('<environment>', '<owner>', '<name>', 'restore', '<bundle name>', 'keep', '<why>');
   ```
   If the newest fails its proof, take the one before it.
4. Read the outcome of a `restored` request:
   - `mainSha`: main now. `previousMainSha`: main before, when it could be read.
   - `keptThrough` against the registry's `last_change`: the changes with a higher number are gone from main. Tell
     the company's owner agent, in a message from Qorpera, which changes must be made again. Their records name
     the sessions.
   - `stranded`: sessions that have neither their branch nor their base commit any more. Archive each: its next
     turn could not start.
   - `movedTo`: the set-aside copy, or null when there was nothing to set aside or it was removed.
5. Check:
   - the registry's `main_sha` is the outcome's `mainSha`;
   - `code/<owner>/<name>/main/` lists in Storage, and there is no `restoring.json`;
   - the next care run ends with `fsck_state = 'ok'` and a new `bundle_name` (the restore made care due at once);
   - the files under `changes/` come back within a few minutes.
6. Send one session a small follow-up and see it land.
7. After 30 days, when nobody asked for anything from the set-aside copy:
   ```sql
   select public.qorpera_request_code_restore('<environment>', '<owner>', '<name>', 'discard', null, null, '<movedTo>');
   ```

## 4. When a request failed

Read `outcome ->> 'code'`. It is up to three parts, joined by colons: the step, the reason, and what state the
place is in.

**The last part tells you what to do.**

| Ends in | The place | Do |
|---|---|---|
| (no such part) | Never touched. | Fix the reason, ask again. |
| `PLACE_AS_BEFORE` | Was closed, nothing was moved, and it is open again as it was. | Fix the reason, ask again. |
| `PLACE_CLOSED` | Closed: `restoring.json` is in it, and turns on the repository fail. | **Ask again at once**, mode `restore`, with the bundle's name from `progress.bundle` (not `fresh`: there may be no place to bundle any more). The new request goes on from what the place holds. |

The truth about closed or open is the place itself: it is closed exactly while `restoring.json` is in
`code/<owner>/<name>/` (look in Storage). `progress` says how far the kernel heard: with `setAside` in it, the old
place is aside; with `built`, the repository is built and only the opening was left.

**The first part is the step**: `FRESH_BUNDLE_FAILED`, `VERIFY_FAILED`, `CLOSE_FAILED`, `SET_ASIDE_FAILED`,
`BUILD_FAILED`, `OPEN_FAILED`, `DISCARD_FAILED`.

**The middle part is the reason:**

| Reason | In plain words |
|---|---|
| `CODE_BUNDLE_MISSING` | No stored bundle has that name for this repository. Check the name against the listing. |
| `CODE_BUNDLE_DIFFERS`, `CODE_HOST_RESTORE_BUNDLE_DIFFERS` | The stored file is not the one its manifest describes. It is spoiled: use another bundle. |
| `CODE_HOST_RESTORE_BUNDLE_FAILED`, `..._BUNDLE_DAMAGED`, `..._BUNDLE_REFS_DIFFER`, `..._BUNDLE_MAIN_DIFFERS`, `..._BUNDLE_NOT_KEPT` | The bundle does not restore what its manifest says. Use another bundle. |
| `CODE_HOST_RESTORE_BUNDLE_FSCK_TIMEOUT` | The check of the bundle's objects did not end in 30 minutes. Ask again; if it repeats, the bundle is very large: see "By hand". |
| `CODE_HOST_RESTORE_REFS_DIFFER_BY_CASE`, `CODE_HOST_NAMES_...`, `CODE_HOST_FILE_TOO_LARGE`, `CODE_HOST_PACK_TOO_LARGE` | The bundle holds names or files the folder cannot hold. Nothing was closed. This needs a developer: see "By hand". |
| `CODE_HOST_RESTORE_NO_SPACE`, `CODE_BUNDLE_NO_SPACE` | Not enough room: a restore needs three times the bundle free on the code host's disk, a fresh bundle twice its size on the executor's storage. |
| `AREA_ABSENT` | `fresh` was asked and there is no repository at the place. Use a stored bundle's name. |
| `CODE_HOST_RESTORE_IN_PROGRESS` | `fresh` was asked while the place is closed by an earlier restore. Ask with that restore's bundle name. |
| `CODE_HOST_RESTORE_OTHER_BUNDLE` | The place is closed for another bundle, and part of that one is already built. Finish that restore first (ask with its bundle's name, which is in `restoring.json`), then restore again from the bundle you want. |
| `CODE_HOST_RESTORE_MARK_UNREADABLE` | `restoring.json` is not a restore's mark. Someone must look at the file. |
| `RESTORE_SET_ASIDE_NOT_KEPT` | The folder did not keep the move of the old place: after a job moved it, the next job still found it there. Do not ask again before the folder service's log for that company was read. |
| `CODE_HOST_RESTORE_MOVE_FAILED`, `CODE_HOST_RESTORE_SET_ASIDE_IN_THE_WAY`, `CODE_HOST_RESTORE_NO_SAFE_MOVE` | The old place could not be moved: the folder refused a rename, a name was already in the set-aside folder, or the code host's `mv` cannot refuse to copy. |
| `CODE_HOST_RESTORE_PLACE_CHANGED`, `CODE_HOST_RESTORE_NOT_SET_ASIDE`, `CODE_HOST_RESTORE_NOT_CLOSED` | The place does not hold what this step expects. Someone wrote there by hand, or a step was skipped. Look at the place before asking again. |
| `CODE_HOST_RESTORE_NOT_BUILT` | The opening found the repository not whole. Ask again: the build runs again. |
| `CODE_HOST_RESTORE_HALF_SET_ASIDE` | Shown only in the log: a closed place could not be opened again, because part of it is already aside. |
| `CODE_HOST_PUBLISH_REFUSED`, `CODE_HOST_PUBLISH_UNANSWERED` | The folder did not save what a job wrote, or did not say. Ask again. |
| `CODE_HOST_BASE_MOVED`, `CODE_HOST_MAIN_FAILED`, `CODE_HOST_RESTORE_REFS_FAILED`, `CODE_HOST_RESTORE_FAILED` | A git step failed while the repository was built. Ask again. |
| `RESTORE_LEASE_LOST` | Another claim has the request, or this executor no longer holds the company. Read the request's state again. |
| `RESTORE_REQUEST_INVALID` | The request names no bundle, path or choice the executor can act on. |
| `UNCLASSIFIED` | The reason has no code. Read the executor's log line `code-restore-error` with that request's id. |

Two codes come from the database, not from the executor:

- `DID_NOT_FINISH`: the request was claimed three times without an end (a restart, or put off three times). Read
  `progress` and the place, and ask again as the table above says.
- `NOT_BUILT`: this executor has no restore. Nothing was touched.

The executor logs each step as `code-restore` (steps `fresh`, `closed`, `set-aside`, `built`, `opened`,
`reopened`, `discarded`, `put-off`, `ended`) and each failure as `code-restore-error`.

While a place is closed, nightly care cannot look at it: the registry's `problem` reads
`CHECK_FAILED:CODE_HOST_RESTORE_IN_PROGRESS` if care came by. That clears with care's next run after the restore.

## 5. The monthly proof

Once a month, for each real repository, prove its newest bundle:

```sql
select public.qorpera_request_code_restore('<environment>', '<owner>', '<name>', 'verify', '<bundle name>', null, null);
```

`done` with `verified` means: this file, as it lies on the storage, restores every ref and passes git's full check.
It runs behind coding turns and writes nothing in the company's folder.

## 6. By hand, anywhere with git

When the executor cannot run, or a bundle needs a developer's hands:

1. Copy `<name>.bundle` and `<name>.json` from the storage.
2. Prove the file is the manifest's: `sha256sum <name>.bundle` must print the manifest's `sha256`, and the size
   must be its `bytes`. A stored bundle is only as good as this check.
3. `git bundle verify <name>.bundle`.
4. `git clone --mirror <name>.bundle <repository>.git`.
5. `git -C <repository>.git symbolic-ref HEAD refs/heads/main`. A bundle says which commit `HEAD` is at, not which
   branch, so the clone guesses a branch at that commit, and it may guess a session's.
6. `git -C <repository>.git fsck --full`.
7. The refs must be the manifest's: `git -C <repository>.git for-each-ref --format='%(objectname) %(refname)'`
   against `refs` in the manifest.

Know what is in the file: every ref (`refs/heads/main`, each session's `refs/heads/qorpera/coding/<session id>`,
the mark `refs/qorpera/kept-here`, tags). `git bundle list-heads` also shows `HEAD` and each worktree's `HEAD`,
outside `refs/`: those are not refs, and the platform's restore does not take them.

## 7. The drill, on a throwaway repository

Before the first real use, then monthly. On node 2, in a scratch company, with the real folder. Write down how
long each step took and how large things were.

1. Have the Co-Founder start a small project in a new repository and land two changes. Keep a second session open
   on it, with one commit that is not landed and one file that is not committed.
2. Switch care on for it and make it due
   (`update public.qorpera_code_repositories set care_enabled = true, next_care_at = now() where ...`). Wait for
   `bundle_name`.
3. Mode `verify` with that bundle: `done`, `verified`. Storage shows nothing new.
4. Land a third change. Mode `restore`, `fresh`, `keep`. Expect: `restored`; `keptThrough` 3; nothing `lost`;
   `movedTo` is `code/_set-aside/<owner>/at-<UTC>/<name>`, and in Storage that folder holds `repo.git`, `main`,
   `worktrees` (with the uncommitted file) and `changes`; `changes/1.md` to `4.md` are written again (4 is the
   restore's own); a follow-up to each session gets its worktree back and lands.
5. Land another change. Mode `restore` with the bundle of step 2, `remove`. Expect: main is back at change 2; the
   later changes are `lost`; the sessions' branches are as the bundle had them; `movedTo` is null and this
   restore's set-aside folder is gone; a follow-up still lands.
6. Make care due again: fsck `ok`, a new bundle.
7. Mode `discard` for the set-aside copy of step 4. Then `verify` on a real repository's newest bundle.

**What the first drill must also prove**, since no test can (each from the folder service's log, Storage and the
executor's log; stop at the first that is not as written):

1. The image: `deploy/code-host/test/prove-code-host-image.sh` passes with this build's `prove-in-code-host.sh`
   (git 2.56.0 does the restore's git work; `mv` knows `--no-copy`; `stat -f` answers).
2. Close: the job's save is one file, `restoring.json`. A turn on the repository then fails with the restore's
   words, and its session is not harmed.
3. Set aside: `mv` of `repo.git`, `main` and `worktrees` succeeds through the folder, each as a rename (no copy:
   the job takes seconds, not minutes). The job's save carries the moves, and the next job sees the place hold the
   mark alone. Note whether the folder saved them in one change set, and how long the save took for the number of
   entries the place had.
4. Under `code/_set-aside/<owner>/at-<UTC>/<name>/`, `repo.git` and its refs are plain files to the folder (no
   lease, no git rule), members can read them, and a member or a session is refused a write there.
5. Build: the packs, the refs and `main/` are saved; a job stopped by hand after the refs (stop the executor)
   leaves a closed place, and the next claim finishes it.
6. Open: the mark's removal is saved, and the next turn works.
7. Discard: `rm -rf` of a set-aside copy succeeds through the folder (its ref files are plain files there), and
   Storage no longer shows it.
8. The code host's disk: a restore needs three times the bundle free under `/var/lib/qorpera-code-host`. Read the
   policy's `codeHost.rootDiskBytes` on each node against the largest stored bundle.
9. The record: the `restore` row is there, the rows a restore went back past say `lost`, and care ran clean.
