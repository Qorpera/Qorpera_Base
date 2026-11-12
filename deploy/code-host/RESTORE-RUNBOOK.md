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
4. **Open.** A job of its own checks that the place holds exactly the bundle's repository. Still inside that job,
   with the mark in place, the restore is written into the change record: it gets its number, and every change's
   state is set to what the restored main holds. Only then is the mark removed. So no change can land between the
   restored main and its record.
5. Only with `remove`: the set-aside copy is removed, after the place is open again.

The request is `done` only after the job that opened the place has saved. Until then it is `running`, also when the
restore is already in the change record (`progress` then has `recorded`).

Three modes:

- `verify`: step 1's proof alone. It writes nothing in the company's folder.
- `restore`: all of the above, from a stored bundle's name, or from `fresh`.
- `discard`: removes one set-aside copy.

`fresh` first takes a new bundle of the place as it stands and stores it like a nightly one. When that works, the
history is sound and no change is lost. When it fails, the history itself is damaged: use a stored bundle.

A `fresh` request that is taken up again (after it was put off, or after its lease ended) uses the bundle it took
before only when the place has not been open since: the place was already seen emptied, or it still holds this
request's `restoring.json` for that bundle. When the place is open (an earlier try moved nothing and opened it
again), changes may have landed there meanwhile. The request then takes a new bundle of the place as it stands
before it closes it, and `progress.bundle` names the new one. If the new bundle fails, the request ends
`FRESH_BUNDLE_FAILED` like a first try and nothing is moved; the earlier bundle is still stored under its name.

A `fresh` bundle must still be all the place holds at the moment the place is closed. The job that closes the
place reads the place's refs right before it writes `restoring.json`, and compares them with the bundle's (main,
every session's branch, every other ref). If anything moved in between (a change landed, a session committed), it
closes nothing, the log says `refs-moved`, and the request takes one more bundle and tries once more. If the place
has moved again by then, the request is put off for two minutes with the place open and untouched, and starts from
a new bundle. A bundle you ask for by its name is not compared: there you chose to go back.

What no bundle holds, `fresh` or stored: files that are not committed (untracked and ignored ones too), commits no
ref names, the reflogs, and each session's worktree as it stood. After a restore those exist only in the set-aside
copy. So ask with `keep`, look at what the sessions had under way, and remove the copy later with `discard`; a
`fresh` request with `remove` deletes that copy in the same request, and with it the only place those things were.

What a restore brings back, and what not:

| | |
|---|---|
| Main | The bundle's main. With `fresh` that is main as it was. With an older bundle, the changes after it are gone from main; their records say `lost`. A later restore from a newer bundle that holds them brings them back: every change's state is worked out again from the main that was restored, whichever way the restore went. |
| Sessions' branches | As the bundle has them. |
| Sessions' worktrees | Not restored. A session's next turn gets a new worktree from its branch. |
| Files a session had not committed, and commits on no branch | Not in any bundle. They are in the set-aside copy. |
| The change record's files | Written again from the database, a little later, each at a new version. |
| Downloads | Over from the moment the restore is let go to set the place aside (their files go aside with it), also when the restore then fails or is put off. That holds for each try: when a first try moved nothing and the place was open again for a while, what was downloaded meanwhile is over when the next try is let go. A download made after the repository is open again stays, also while the restore removes its set-aside copy. A member asks for the code again once the repository is open. |
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
   Names that begin `import-` (code brought in from elsewhere, as it came, `qorpera.code-import-bundle/v1`) sort after every dated one and are never a restore's source: take the last dated name.
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
   - `running`: `progress.step` says which step: `fresh`, `close`, `set-aside`, `build`, `open`, `discard`, or
     `reopened` (the executor found the place open again as it was, and said so). With `progress.recorded` the
     restore is in the change record, and only the opening of the place, or its finish, is left.
   - `queued` again with `not_before`: a turn came first. It goes on in two minutes, from where it was. If nothing
     had been moved yet, the place was opened again meanwhile (a `fresh` request then takes a new bundle when it
     goes on).
   - **When a restore is put off, and when not.** There is one rule. Until it is let go to close the place, a
     restore waits for quiet sessions: at the claim, and before each job (the jobs of a `fresh` bundle and the
     close itself). From the close that is let go, `progress` has `held: true`. The database writes that itself
     and keeps it through every later step and claim; nothing the executor sends changes it. While it is there the
     request is not put off for the company's sessions any more: the place is closed to them or about to be, the
     request is handed out again whatever they do, and its jobs keep their place in the company's line until the
     repository is open again. That also holds after a restart at any point from the close on: the next claim
     first reads the place, under a step named `fresh` or `close`, and goes on from the mark it finds.
   - `held` goes away in one case only: the executor saw the place open again as it was (no `restoring.json`). That
     is so when the close wrote no mark (the bundle's proof failed, the job gave way to a turn's, the place had
     moved on since a `fresh` bundle), when a first try moved nothing and the place was opened again, and when a
     later claim reads the place and finds no mark. It then says `reopened`, before it asks anything else, and from
     there the request waits for quiet sessions like a new one. If that word was not heard, `held` stays, the try
     ends, and the next claim reads the place and says it again; it closes nothing before the database has taken
     that word.
   - A request that ends `failed` keeps `held`. The next restore you ask for the same place begins with it
     (`progress` is `{"held": true}` from the start), so it does not wait for quiet sessions while the repository
     may still be closed: it reads the place first, goes on from the mark it finds, or says `reopened` and waits
     like any new request when the place is open.
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
   - `change`: the restore's own number in the change record.
   - `boundary`, `keptThrough`, `lost`, `back`: what the database found when it recorded the restore. It reads the
     changes' own rows, however many there are, to find which of them the restored main holds.
     - `boundary: found`: every change's state is right for the restored main. `keptThrough` is the newest change
       main holds (0: none). `lost` is how many changes this restore took out of main, `back` how many an earlier
       restore had taken out and this one brought back. List the lost ones:
       ```sql
       select n, title, state from public.qorpera_code_changes
       where environment_id = '<environment>' and owner = '<owner>' and name = '<name>' and state = 'lost' order by n;
       ```
       Tell the company's owner agent, in a message from Qorpera, which changes must be made again. Their records
       name the sessions.
     - `boundary: unknown`: the commit that was restored is one no change in the record names (the bundle was taken
       at a main the record never heard of). **Nothing was marked lost by a guess**: the states of the changes
       before this restore were left as they were, and some may be wrong. The executor's log has the line
       `code-restore-error` with `RESTORE_BOUNDARY_UNKNOWN` for the request. Compare `changes/index.md` with main
       by hand (`git log --first-parent` in a clone of the bundle) and tell the owner agent which changes main no
       longer holds. A later restore from a bundle the record does know sets every state right again.
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
| `PLACE_CLOSED` | Closed: `restoring.json` is in it, and turns on the repository fail. | **Ask again at once**, mode `restore`, with the bundle's name from `progress.bundle` (not `fresh`: there may be no place to bundle any more). The new request goes on from what the place holds, and does not wait for quiet sessions: it begins with `held`. |

The truth about closed or open is the place itself: it is closed exactly while `restoring.json` is in
`code/<owner>/<name>/` (look in Storage). `progress` says how far the kernel heard: with `held`, a job was let go
to close the place and the place was not seen open since (whether it is closed, and whether anything moved, the
place says); with `setAside` in it, the old place is aside; with `built`, the repository is built and only the
opening was left; with `recorded`, the restore is in the change record.

**A restore that is recorded and whose place is still closed.** The record is made inside the job that opens the
place, before the mark goes. What happens when something stops there:

| What stopped | Where it leaves things | Who repairs it |
|---|---|---|
| The record was not heard by the database (asked twice in the job). | Nothing recorded, or recorded without the executor knowing. The mark is in place. The request is put off: `queued` with `not_before`, or still `running` until its lease ends when the database could not be told that either. | The next claim (two minutes later, or after the lease): its job records (made again, it is the same record: no second row) and opens the place. |
| The record was made, and the mark could not be removed or the job did not save. | Recorded, place closed, request put off the same way. The log has `code-restore-error`, step `open`. | The next claim, the same way. |
| The executor stopped between the record and the request's finish. | Recorded. The place is open if the job had saved, closed if not. The request is `running` until its lease ends (up to two hours after the last step). | The next claim after the lease: it opens the place if it is closed, and ends the request. Nothing is recorded twice. |
| Three claims went by without an end. | The request is `failed` with `DID_NOT_FINISH`, `progress` has `recorded`, and the place may still be closed. | **You.** Look in Storage. Without `restoring.json` the repository is open and whole: nothing is left to do. With it, ask again at once, mode `restore`, with the bundle's name from `progress.bundle`. The new request builds what is missing, opens the place and ends `restored`; the change record gets no second row for it, because its newest movement of main is already this restore. |

A request never ends `done` before the job that opened its place has saved, and the request's finish records
nothing: a restore is recorded only while its place is closed. A finish for a restore that was never recorded is
refused by the database (`Code restore is not recorded`), and the request is claimed again.

**An import that recorded its repository and can never open (not drilled).** Code brought in (a request of kind
`import`) closes, builds and opens its place with a restore's jobs, and records its repository (the registry row and
change 1) inside its open job, before the mark goes. From that record on the database never ends it: only the
executor's finish `done/imported` does, once the place is open, and a claim hands it out again each time its
15-minute lease ran out, however often. While it runs, no other request of that company is claimed. So an import
whose open fails every time (`progress` has `recorded`, `attempts` keeps growing, and the executor's log has
`code-import-error`, step `open`, with the same code on each claim) holds back the company's undos, downloads and
restores until you end it:

1. Find it, and read the bundle its mark names:
   ```sql
   select id, state, attempts, lease_until, progress -> 'recorded' ->> 'bundle' as bundle
   from public.qorpera_code_requests
   where kind = 'import' and profile_id = '<company id>' and state in ('queued', 'running');
   ```
2. End it as the database ends a request past its claims. The statement changes nothing while an executor holds a
   live lease: it must say `UPDATE 1`; if it says `UPDATE 0`, run it again after `lease_until`.
   ```sql
   update public.qorpera_code_requests set state = 'failed', lease_token = null, lease_owner = null,
     lease_until = null, finished_at = now(), updated_at = now(),
     outcome = '{"schema":"qorpera.code-request-outcome/v1","state":"failed","code":"DID_NOT_FINISH"}'
   where id = '<request id>' and kind = 'import' and progress ? 'recorded'
     and (state = 'queued' or (state = 'running' and lease_until <= now()));
   ```
   A finish the executor sends for it later is `lost`, and no claim hands it out again.
3. The place is still closed: `restoring.json` names that bundle, and turns on the repository fail with the restore's
   words. Ask a restore as the `PLACE_CLOSED` row says: mode `restore`, with that bundle's name and `keep`. Its close
   finds the mark for the same bundle and goes on from it (the mark's request id is not compared); it opens the
   place and records a restore, change 2, at main as it was brought in.
   **One thing is not as in that row: this restore waits for quiet sessions.** `held` passes on from a failed
   restore to the next restore of the place, never from an import, so the restore you ask starts without it and
   stays queued (`waiting`: `SESSIONS_BUSY`) while the company's sessions are working or one of this repository's
   sessions is attached to a machine, with the place closed all the while. Before you ask, wait until their
   machines sleep (ten quiet minutes) or archive those sessions, as "Before you start" says; then ask, and read
   `progress` until it has `held: true`.
4. If that restore fails at its open too, leave the place closed: nothing is lost (the source the import came from
   and both its bundles are kept). It needs a developer, as in "By hand".

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
| `RESTORE_BOUNDARY_UNKNOWN` | Never a failure: shown in the log beside a restore that succeeded. The change record does not know the commit that was restored, so the states of its earlier changes were left as they were. See section 3, step 4. |
| `UNCLASSIFIED` | The reason has no code. Read the executor's log line `code-restore-error` with that request's id. |

Two codes come from the database, not from the executor:

- `DID_NOT_FINISH`: the request was claimed three times without an end (a restart, or put off three times). Read
  `progress` and the place, and ask again as the table above says.
- `NOT_BUILT`: this executor has no restore. Nothing was touched.

The executor logs each step as `code-restore` (steps `fresh`, `refs-moved`, `closed`, `set-aside`, `built`,
`recorded`, `opened`, `reopened`, `discarded`, `put-off`, `ended`) and each failure as `code-restore-error`. The
`recorded` line carries what the database found: `change`, `boundary`, `keptThrough`, `lost`, `back`. `refs-moved`
names the `fresh` bundle that was not used because the place had moved on before it was closed.

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
4. Land a third change. Mode `restore`, `fresh`, `keep`. Expect: `restored`; `boundary` `found`; `keptThrough` 3;
   `lost` 0;
   `movedTo` is `code/_set-aside/<owner>/at-<UTC>/<name>`, and in Storage that folder holds `repo.git`, `main`,
   `worktrees` (with the uncommitted file) and `changes`; `changes/1.md` to `4.md` are written again (4 is the
   restore's own); a follow-up to each session gets its worktree back and lands.
5. Land another change. Mode `restore` with the bundle of step 2, `remove`. Expect: main is back at change 2;
   `keptThrough` 2; the later changes are `lost` (and `lost` counts them, the restore of step 4 among them); the
   sessions' branches are as the bundle had them; `movedTo` is null and this restore's set-aside folder is gone; a
   follow-up still lands.
6. Mode `restore` with the bundle step 4 stored (its name is in that request's outcome), `keep`. Expect: the
   changes step 5 lost are in main again, `back` counts them, the follow-up of step 5 is `lost`, and an undo of
   the third change (ask the Co-Founder) works.
7. Make care due again: fsck `ok`, a new bundle.
8. Mode `discard` for the set-aside copies of steps 4 and 6. Then `verify` on a real repository's newest bundle.

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
9. The record: the `restore` row is there, the rows a restore went back past say `lost`, the rows a restore to a
   newer bundle brought back say `in main` again, and care ran clean.
10. The record's place: in the executor's log each restore's `recorded` line comes before its `opened` line, and a
    turn started on the repository while the restore's last job runs lands after it and is not `lost`.
