# Dependencies and builds on the machine: the plan

Status: plan, for review before it is built; the coordinator chose the first option of all four questions on
15 October ("Decisions" at the end). It builds the contract's "2026-10-14 amendment: machines work in the
folder as on their own disk", item 8 (dependencies and builds stay on the machine), and the line of its "For the build"
list that says the folder program keeps item 8's caches on the machine. It replaces
[RUNTIME-COMPANY-FOLDER.md](RUNTIME-COMPANY-FOLDER.md) §6 "The per-session cache" and finishes what
[RUNTIME-FOLDER-CODING-MACHINES.md](RUNTIME-FOLDER-CODING-MACHINES.md) "The cache list" started. Facts about today are
from master at 13ac00f9e and from step 5's slice 5d, git on the mount (#1096 at f2df8b963, not merged yet).

Item 8 says: "On every machine, as on coding machines (27 September, item 9), a project's installed dependencies and
build output are the machine's own cache: for example `node_modules`, virtual environments, build folders and, in a
git repository, what its `.gitignore` leaves out. They are never published, and each machine installs or builds its
own."

**Today.** No machine carries the folder yet (amendment item 10). On master:
- the core refuses `.git` and `node_modules` outside `code/` (`qorpera_folder_path_reserved`), and so does the folder
  service (`checkNewPath`, `EPERM`), so `npm install` outside a code area fails;
- §6 plans a fixed list of 14 folder names per worktree, kept in the session's NAS cache folder, with "no
  ignore-pattern matching";
- the folder service keeps lock, swap and backup names out of every change set (`neverPublished`), but they still
  pass through the service and the NAS.

**5d (#1096)** builds the first part of the program's cache, for code worktrees only:
- `local.rs` and `mount/on_disk.rs`: a local layer on the machine's disk (`--local-dir`, by default `local/` in the
  mount's state folder). The mount shows its files at their paths in the folder, but never sends them to the node.
  A rename or hard link between the local layer and the folder answers `EXDEV`;
- `cache.rs`: inside `code/<owner>/<name>/worktrees/<worker>/`, a new folder named with one of §6's 14 names, at any
  depth, lives in the local layer. A name leaves a worktree's list once the worktree's index has entries under it, and
  stays off; what the node has at a path always wins;
- `index.rs`: the reader of git's index.

This plan reuses all of that (agreed with the 5d owner, 15 October). It adds the rule for the rest of the folder, git's
ignore rules, and where the cache lives so that it outlives a mount.

## What the slices deliver

On any machine that carries the folder, `npm install`, `pip install` into a virtual environment, `cargo build`, `tsc`
and the like work in `/company` at the speed of a local disk. What they make is the machine's own: it is never
published, other machines and views see nothing of it, and the web app, `company_list`, `company_search` and the
history never show it. In a git repository, a file or folder that git ignores stays on the machine too, unless git
tracks it. The cache outlives the mount and the command, so the next command in that folder on the machine does not
install again. Old dependencies and builds are removed when unused or when the disk runs short; what is cache only
because git ignores it stays until its worktree goes.

## The rules

A **cache path** is a new file or folder that the folder program keeps on the machine's disk. The program decides when
a name is made: a `mkdir`, a `create`, a `symlink`, a `link` or a rename onto a name. Everything under a cache folder is
cache too.

1. **What the node has wins.** A path where the node has an entry is never cache, whatever its name. So an existing
   published file or folder never falls back into a cache. If the node later gets an entry at a cache path (another
   machine made it there), the mount shows the node's entry, and the local one goes.
2. **Dependency names, anywhere.** A new folder with one of these names is cache in any folder:
   `node_modules`, `.pnpm-store`, `.venv`, `venv`, `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`,
   `.tox`, `.gradle`, `.turbo`, `.next`, `.nuxt`, `.svelte-kit`, `.parcel-cache`.
   - `.pnpm-store` is here because pnpm makes its store at the top of the file system its project is on when that is
     another file system than the user's home. That top is `/company`.
   - `vendor` and `.yarn` are left out on purpose: projects often commit them.
3. **Build names, in a project.** A new folder named `dist`, `build`, `target`, `out`, `coverage` or `.cache` is cache
   when its parent folder is a project: it holds `package.json`, `Cargo.toml`, `pyproject.toml`, `setup.py`,
   `requirements.txt`, `go.mod`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `Gemfile`, `composer.json`, `mix.exs`,
   `deno.json` or `CMakeLists.txt`. Elsewhere these are ordinary names: a `build` folder of drawings in `projects/`
   is company work.
4. **In a git worktree, git decides too.** Inside `code/<owner>/<name>/worktrees/<worker>/`:
   - rule 2 holds, and so do the rest of §6's list (`target`, `dist`, `build`, `coverage`, `.cache`) at any depth
     with no project needed, as 5d builds it. `out` counts only when git ignores it;
   - a new file or folder that git's ignore rules leave out is cache: every `.gitignore` from the worktree's top down to
     the path, and the repository's `info/exclude`. A machine's own global ignore file does not count, because it is
     not part of the repository;
   - a path the worktree's index tracks is never cache (5d's index reader). When git starts tracking a cache path
     (`git add -f`), it moves into the folder as a pending change and is published at the next boundary, as 5d does
     for a cache folder whose name leaves the list;
   - a name that left the list stays off it (§6).
   Repositories live only in code areas: `.git` stays refused outside `code/` (decision 3 below).
5. **Names match exactly.** `Build` and `BUILD` (Bazel's file) are not `build`. Rules 2 and 3 decide folders only: a
   file named `build` is published. Rule 4 decides files and folders.
6. **A change of the rules does not move what exists.** A `.gitignore` that changes, or a project file that appears or
   goes, decides only names made after it. A cache folder stays cache until it is removed or git tracks it.

## What a cache path does

- **Reads and writes** go to the machine's disk, at the disk's speed. Nothing reaches the folder service, the NAS or
  the core. Reading a cache file is not a read of company data: it is not in the read log or a run's read set.
- **Listings** of the parent folder show the published entries and the machine's cache entries together. The cache
  entries are the machine's own: another machine, another owner's view (below), the web app and the server-side tools
  see nothing at that path.
- **Inside the cache** every operation is a local one: rename, hard link, symbolic link, `chmod`, times. A symbolic
  link inside the cache (`node_modules/.bin/*`, pnpm's links) is a link on the machine's disk, not a folder link of
  [RUNTIME-FOLDER-LINKS.md](RUNTIME-FOLDER-LINKS.md).
- **Across the edge:**
  - a folder renamed between the cache and the folder answers `EXDEV`, as across two disks; `mv` then copies and
    removes. So does a hard link across the edge, and a published file renamed into a cache path;
  - a file renamed from the cache onto a published path is published there: the program writes it into the view as a
    new pending file and removes the local one. This keeps atomic saves working where the temporary name is ignored
    (an editor writing `notes.md.tmp`, then renaming it over `notes.md`, in a repository that ignores `*.tmp`). Over a
    file of the folder's it is the session's save of that file, and it keeps the cache file's executable bit. A cache
    file still open for writing (here, or in another mount that shares the cache) is waited for up to a second. One
    still open then answers `EXDEV`, and so does a rename onto a file of the view's that is open for writing, or onto
    anything but a file;
  - a new pending file (made in this view and never published) renamed onto a cache path moves into the cache, and
    leaves the view's pending changes. The same atomic save works the other way round (`.env.tmp` over `.env`, which
    git ignores). The program knows such a file this way:
    - it notes the path when it makes the file where the folder's listing has none, or when a cache file is renamed
      onto a new name (above). The note follows a rename of the file itself;
    - it drops the note at any change the feed tells of at or above the path (a boundary published it, or another view
      changed it), when the view lists again, when the feed comes back after a loss (while it is lost, such a rename
      answers `EXDEV`), and when a folder's rename takes the file along (the folder service gives the moved files new
      versions);
    - at the rename, the folder service must list the file as this mount's own save (the version the mount wrote, with
      no authority of its own), and nothing may have it open for writing;
    - when the answer to the program's removal of the folder's file is lost, it asks again for up to five seconds. A
      file whose removal it still cannot confirm stays in the cache as well, and the rename answers `EIO`: the folder
      may then still have the file too, as after a crash in the middle of a rename, but its bytes are never lost.
    Anything else answers `EXDEV`, so `mv` copies: the cache gets the machine's copy, and the folder keeps its file
    until `mv` removes it, which is a pending change like any removal.
- **A published folder holding a cache:**
  - `rmdir` sees the cache entries, so it answers `ENOTEMPTY` until they are gone; `rm -r` removes them first;
  - renaming the folder moves its cache with it, once the folder service has taken the rename;
  - when the folder goes from the view in another way (another machine removed or moved it), its cache folders are
    dropped.
- **Boundaries** do not wait for cache files: a cache file open for writing holds up nothing. The one exception is a
  cache git came to track (rule 4): its move into the folder waits for a writer to close the file, and until the move
  is done `qorpera-folder publish` refuses ("publish again shortly"), so no boundary leaves out a file git tracks.
- **A full disk** answers `ENOSPC` to the writer, as a local disk does.

## Where the cache lives

The cache is a folder on the machine's disk, owned by the folder program's user and closed to every other user. The
program serves its files through the mount, so the processes that use them need no access to the folder itself. It
is never under `/run`, which empties at every start and is memory.

- A new flag, `--cache-dir <dir>`, names it. 5d's `--local-dir` keeps the session's own git files (§6: they are seeded
  again when another view finds them). The cache moves out of it, because a cache is shared by several mounts and a
  session's git files are not.
  - The folder must exist, by an absolute path of at most 80 bytes (its sockets' names must fit), as a real folder
    (not a link) of the program's account, closed to every other (mode `0700` or narrower), neither inside
    `--local-dir` nor holding it. Otherwise the program does not start: `FOLDER_CACHE_DIR_UNUSABLE: <dir>: <why>`.
  - It holds `caches/` (the cache files, under their folder's path), `programs/` (a socket for each running program,
    "The kernel cache") and `gone/` (what is being taken off the disk). Given the flag, a program lets go of an old
    `caches` folder under `--local-dir`.
- **Who passes it** is the trusted side that starts the program: on company machines the folder helper
  (`cloud-company-computer-folder-helper.ts`, step 4), on coding machines the guest agent (step 5's 5f and 5g), on test
  machines 6d's guest. Without the flag, the program keeps its cache under `--local-dir`, for that mount only (5d's
  behaviour).
- **Coding machines** (step 5's plan, from its owner on 15 October): the guest agent starts one folder program per
  session, each with its own uid and worktree (`worktrees/<worker>/`), and gives each its own `--local-dir`,
  `/var/lib/qorpera-folder/local/<worker>`. A member's parallel sessions run their programs at once on the one
  machine. They share the machine's `--cache-dir`.
- **The key.** Company machines carry many owners: desktop holders change, and every offline command gets a view and
  a mount of its own (4b). A cache made in one view must not show in a view of a different authority. So:
  - **company machines, desktops:** one cache for all the machine's desktops, `/var/lib/qorpera-folder/cache/desktop`.
    Every desktop view has the same company-wide authority, whoever holds it (decision 1 gives the proof), so a
    takeover or a new run keeps the desktop's mount and its cache;
  - **company machines, commands:** one cache per owner on the machine: `/var/lib/qorpera-folder/cache/<owner>`, where
    the owner is the command's agent, `agent-<uuid>`, from the core's answer to the view's open (`owner`). The helper
    also takes `member-<uuid>`, for a member's view of that kind; the core opens none today. All of one agent's
    commands share it, so `npm install` in one command and `npm test` in the next work as on one disk. A command never
    sees the desktops' cache, so an install made on the desktop is made again by a command: that costs speed only;
  - **coding and test machines:** one cache per machine, `/var/lib/qorpera-folder/cache/machine`. Root inside the
    machine already joins its sessions (contract item 11, "Root makes one member's sessions on one machine no walls
    between each other"), so walls between their caches would protect nothing;
  - the folder helper refuses a mismatch: a desktop with an owner's cache, a command with the desktops' cache, or an
    owner of another shape;
  - a company-wide view renews only while its agent and member still read the folder's root, as its open required
    (migration 20260930516000), because a cache's files are on the machine and the core never authorizes them again.
    A principal that loses the root read (a member who leaves, an agent whose grant is revoked or lapses) has its views
    closed at their next renewal; their caches stay where they are until removal (below). The folder service renews
    every 40 s and tells the machine of the closure at once. From then on the core refuses every read and publish of
    the view, and only files already in the machine's cache can still be read, until the mount ends: a command's at
    the closure (at most 40 s after the loss), a desktop's after its 60 s handoff grace (at most 40 + 60 s), when the
    folder program exits 3 and its unit unmounts it. The grace is the folder program's
    (`crates/qorpera-folder/src/link.rs`, `expire` and `note`), and the folder service gives it to desktop views only
    (`switchable`).
- **A cache is kept at its path.** A `node_modules` made in one folder serves that folder only. A command on a company
  machine that works in the folder the last one worked in finds it. A new coding session works in a new worktree, so
  it installs again, as a new git worktree on a local disk does; the package managers' own stores in the user's home
  on the machine (npm's, pip's, cargo's) keep that install off the network. `.pnpm-store` at the top of `/company` is
  one per cache, so pnpm's sessions share it. A cache kept by content (a lockfile's hash, say) to carry
  `node_modules` from one worktree to the next is not in this plan.
- **Several mounts at once.** Several folder programs can serve one cache folder at a time (a desktop and two commands
  of one agent), all as one account. A process sees what another mount wrote at once, as on one disk; "The kernel
  cache" below keeps that true. What two programs run at once in one project (two `npm install`s) is the user's
  business, as on any disk. No program takes caches another one may be using:
  - a listing that lacks a cache top never drops it; only an event does (the node's entry at its name, the move of its
    folder, the folder gone from the view). A mount keeps the caches of a folder its own view does not have, as
    another view may have made that folder and not published it yet. They go when removing old caches finds the
    folder gone;
  - the node's rename of a folder whose caches another program already moved does nothing;
  - MC2a's seal sees the other programs' write handles: each handle that changes a cache file's bytes holds a shared
    lock on the file, which the seal takes exclusively, without waiting;
  - every check and change of names in the caches (a create, rename or removal, a cache move and its removal after)
    holds an exclusive lock on `<cache-dir>/names`, so no program changes a name between another's look and its
    change;
  - a program reaches a cache folder from the top one folder at a time, never through a link, each checked to be the
    folder it asked of, so a link another program puts in a folder's place never leads it outside the caches; a
    folder reached lately is held open and used again only while the kernel names it where the program's names say;
  - each program takes what it removes off the disk through its own folder in `gone/`, which it holds locked; a
    program that starts takes off only what no running program holds.
- **Speed.** "At the speed of a local disk" is the point of item 8. With no kernel cache, every `stat` and `open` in a
  `node_modules` goes through the program: a load of 3000 small modules took 12.7 times as long as on the plain disk,
  and 5.1 times with MC2b's caches (names inside a cache kept, tops not). So MC3 gives cache files a kernel cache
  (below; the coordinator's pick, 18 October). The speed test
  (`packages/object-gateway/test/folder-cache-speed-e2e.test.ts`, run by hand on a node) times the same project on the
  plain disk and on mounts: `tsc --noEmit` on a project with its dependencies installed, a load of 3000 small modules,
  alone and while another mount on the cache folder makes and removes names in it, and stats and reads of 2000
  published files; and each program's CPU over a minute idle. The target is about twice the plain disk at most for the
  load alone, and with a busy peer no worse than MC2b's (the coordinator's ruling, 18 October). MC3a's PR body gives
  the numbers.

## The kernel cache

For cache files only (local files in the caches, and cache tops), the kernel keeps:
- names and attributes for `--ttl-seconds`; a cache top's while the program hears the node's changes, as the node's
  entry may win its name (rule 1), else not at all;
- absent names in a cache folder, for the same time;
- the pages of a read-only open, when the file is as this mount last opened it (the same ctime, mtime, size and inode
  generation; so a disk inode number used again, or a change nobody told, drops them). Such an open sends no FLUSH at
  its close.

Company-folder files and session-local git files keep their answers as before. Opens, releases and writes of cache
files still reach the program, so it sees every handle (the seal, the removal locks) and every change.

**What changes behind the kernel's back.**
- In the program's own mount: the node's entry winning a top's name, caches moving with their folder or into the
  folder, caches going with their folder, the node's changes heard again after the feed was lost. After the change the
  program raises its mount's epoch (`FUSE_NOTIFY_INC_EPOCH`), so every name made before it is looked up again at its
  next use.
- In the other programs on one cache folder: each one, before it serves anything, listens on a socket in
  `<cache-dir>/programs/`. Every change a program makes in the cache folder (a write, a truncate or other attribute
  change, create, mknod, mkdir, symlink, link, unlink, rmdir, rename, the moves above) is told to every other one
  listening there before its own reply: a local inode (the disk's number, the same in every program) and the name it
  changed, if any, in its folder (a local folder by its inode, a node folder by its path). The order is the change on
  disk, the list of listeners, the telling, the reply, so a program that starts after the list was taken read the disk
  after the change.

**The answer to a told change takes no lock** (the coordinator's point (A), 18 October). A told program only drops
the inode's attributes (`inval_inode` with offset -1), raises its epoch for a name its kernel may hold (below), and
forgets the inode's open stamp; then it answers. Its pages drop afterwards on a thread of their own, for memory. A read
through an fd held open asks for the attributes again (`FUSE_AUTO_INVAL_DATA`) and drops the pages itself when the
size or mtime changed. Dropping pages or an entry before the answer could wait for a page lock or a folder lock that
one of the told program's own requests holds while it waits for the teller: a cycle. A write from the kernel's
writeback (a shared mapping) tells without waiting, so no page under writeback waits for another program. No program
tells while it holds a lock of its own.

**Which names raise the epoch** (the coordinator's name filter, 18 October). The epoch is for the whole mount, so a
program that raised it for every told name made a busy neighbor's churn cost it every name it held (a load of 3000
modules took 10 times the plain disk next to a mount making and removing names). A told program raises it only for a
name its kernel may hold:
- Each program keeps a table of the names in local folders it handed its kernel: the answers to its lookups, found
  and absent, and to its own create, mkdir, symlink, link, rename (both names) and removals. A name goes in before the
  program reads or changes the disk, and stays until the time-out that answer handed has passed after the answer, plus
  60 seconds. So a name missing from the table is one the kernel cannot hold: a lookup of it reads the disk after the
  change. The kernel takes the epoch before it sends a request, so an answer on its way when the epoch rises is stale
  at its first use.
- A name in a node folder (a cache top) always raises it.
- Listings hand the kernel no names: the program does not take `READDIRPLUS` (and a test fails if it ever does).
- The table holds at most 100 000 names (131 072 slots of 33 bytes, about 4.3 MB). When it is full, the program first
  lets go of the names whose time passed; if more than half are still held, it lets go of all of them and raises its
  epoch at once, before the table takes a new name. If that epoch fails, the kernel cache goes off (below). It never
  skips the raise.

**When the kernel cache is off.** The program uses it only if the kernel granted `FUSE_AUTO_INVAL_DATA` and has the
epoch notify (FUSE 7.44 or later), and a write in the cache folder changes the file's times every time (checked at the
start). Otherwise it runs without it and logs why: a cache top's names then have a time-out of zero, and on a shared
cache folder so does every cache name, with no kept pages. It turns the kernel cache off for good, and drops all it
handed the kernel, when a notify fails (other than "not cached"), when it hears a change later than the teller waits,
or when it no longer hears the others. If that drop fails too, the program exits, and its mount answers `ENOTCONN`:
closed, never stale. Its log says `kernel cache on` or `kernel cache off: <why>`.
- A listener that does not answer within 10 seconds fails the teller's request with `EIO`; a dead one (its connection
  refused) has its socket removed.
- A told message can only drop something. A malformed or unknown one is logged, and as the change it meant is unknown,
  the listener drops all it handed out.

**A known limit: mappings.** A read, a `stat`, an open and an fd held open see another mount's change at once. A
mapping (`mmap`) made before another mount's write sees the change after the page drop on the other thread, shortly
after the write (the test allows 10 seconds). Writes through a shared mapping reach the other mounts after writeback,
not ordered with `msync` or `fsync`. Before MC3 (MC2b) the case did not arise: each mount had caches of its own, and
another mount never saw the file at all. Within one mount a mapping sees a write at once, before MC3 and with it.

**At the end** (the coordinator's closure fix, 18 October; session 39's row 4). A process may hold the view past its
end: an fd, a folder's fd it opens names through, a mapping. Its kernel keeps the pages it read (`FOPEN_KEEP_CACHE`,
before MC3 too), so without more it would read them after the end. So at the end (the view's close, a stop's SIGTERM,
a fall-back that exits, or the kernel ending the session), in this order:
1. The program refuses every request with `EIO`. The check is one flag, read before any lock.
2. It has the kernel drop the attributes and pages of every inode ever opened through the mount
   (`inval_inode(ino, 0, 0)`; mapped pages are unmapped). Every open (of a file or a folder) and create notes its
   inode in a set never emptied, then checks the flag again before its reply. A thread of its own drops them, while the program's loops go on answering (each request with the
   refusal), so a page lock the kernel holds for a request in flight is let go. It waits at most 15 seconds, then goes
   on, so the exit stays inside a stop's 20 seconds before its SIGKILL (`TimeoutStopSec=20s`, `KillMode=mixed`).
3. It unmounts and exits.

The end has one owner, its first caller. A second (a SIGTERM during a fall-back's end, or the other way round) waits
for the first one's drop, up to the same 15 seconds, so no caller unmounts or exits before the drop is done.

An open or a create answered noted its inode before a check that found the flag unset, and the drop takes the set
after setting it: so the set has every inode a process holds open. A read that passed its check before the flag fills
a page the kernel holds locked until the answer, and the drop waits for that lock: so no page filled through the mount
outlives the drop. A create's inode the kernel makes only when it reads the reply, which can come after the drop; so a
create's reply hands the kernel no entry and no attributes to keep, and the open's permission check asks for them at
once (`default_permissions`). After the end that ask is refused, and such a create opens nothing (one more `getattr`
per create the rest of the time). A hard link of a cache file hands no attributes either: the kernel takes a link's
attributes for the inode it holds without asking whether it dropped newer ones since, so a reply after the drop would
give a fd held on the file its attributes back. Instead that fd's next `stat` asks, and is refused. After the drop, a
read, a `stat` and an open through a held fd, of a file or a folder, fail (`EIO` while the program runs, `ENOTCONN`
after), and a mapping's next touch gets `SIGBUS`. Three limits:
- A page a process pinned before the end (`O_DIRECT` into a mapping, `vmsplice`, a registered buffer) stays the
  pinner's: it keeps only what it took before the end.
- The dirty pages of a shared writable mapping not written back by the end are lost: their writeback is refused, and
  the next `msync` or `fsync` gives `EIO`.
- A folder or file held without an open (a working folder, an `O_PATH` fd) is not in the set: the kernel keeps its
  attributes until their time-out (`--ttl-seconds`). Its contents need a read or a listing, which fail.

A SIGKILL before the drop is done ends the session (the kernel aborts the connection when the process dies), and the
pages not yet dropped stay held: a held fd reads them until their attributes' time-out (`--ttl-seconds`) passes, a
mapping until it is unmapped. The drop is far inside the 15 seconds (the PR body has the times).

## Removing old caches

A cache is removed by its **top entries**: a cache folder or a cache file whose parent is published (each
`node_modules` and `dist`, an ignored `.env` or `debug.log` in a worktree). What is under a top cache folder goes with
it.
- **What may be removed.** A top entry made by its name (rules 2 and 3, and §6's list in a worktree) holds what an
  install or a build makes again. A top entry that is cache only because git ignores it (rule 4) may hold what nothing
  makes again: a `.env`, a local database, notes. The program never removes those on its own. They go with their
  published parent (below) or when someone removes them, as on a local disk.
- The program removes old caches when it starts and once an hour while it runs:
  - a top entry made by its name and unused for 14 days goes;
  - when the disk has less than 10% free, the least recently used of those go first, until 15% is free or none is
    left. A writer then gets `ENOSPC`, as on a full local disk;
  - a top entry of either kind whose published parent is gone (rule above) goes at the next pass. So a worktree that
    is removed takes its ignored files with it.
- **An open entry is never removed.** Each program holds a shared lock on each top entry it serves; removal takes it
  exclusively without waiting, and skips the entry when it cannot.
- Each top entry has a small record beside the cache and outside every mount: how it was made, when it was last used
  (updated at most once an hour), and its lock. A removed cache is built again by the next install or build, as on a
  fresh machine.

## What does not change

- **The core and SQL.** A cache never reaches the core. The core's refusal of `node_modules` outside `code/` stays as
  the last check. MC3c's migration 20260930516000 (SQL test 538) only names a command view's owner in the open answer
  and makes a company-wide view's renewal check the root read again ("The key", above).
- **The folder service.** Nothing for caches: a cache path never reaches it. Its `checkNewPath` refusal of
  `node_modules` stays for a program without these slices.
- **The server-side tools and the web app.** Nothing: they never see a cache.
- **What git commits.** The rules decide what is published, not what git commits: `git status` in a worktree shows
  untracked cache folders that the repository does not ignore, as on a local disk.

## Slices

| Slice | What | Tests |
|---|---|---|
| MC1 | Folder program: rules 1, 2, 3, 5 and 6 everywhere, on 5d's local layer and cache list (one table of names, shared with rule 4's worktree list); listings; the edge (`EXDEV`, `rmdir`, a published folder's rename moving its cache, a gone parent dropping it); boundaries not waiting for cache files. A new build record and the installer pins | FUSE tests with the stand-in service: `npm install` (from a local registry folder, no network) in a project folder outside `code/` making `node_modules` that the service never sees, a second view listing nothing there; `pip install` into `.venv`; `.pnpm-store` at the top; `build` made in a project (cache) and in a plain folder (published); a file named `build` published; `Build` published; a name where the node has an entry not cache, and the node's later entry winning; `rmdir` `ENOTEMPTY` with a cache inside, `rm -r` removing it; `mv` of the parent moving the cache; the parent removed by another view dropping it; a folder renamed across the edge `EXDEV` and `mv` copying; a hard link across `EXDEV`; links and hard links inside the cache; a boundary while a cache file is open |
| MC2 | Folder program: rule 4's ignore rules (every `.gitignore` and `info/exclude`, with negation, folder patterns and `**`, from a pinned crate that follows git's rules, or a small matcher if the build's dependency review prefers it), on 5d's index reader for what is tracked; a file renamed across the edge (published from the cache, moved into it while pending); `git add -f` of an ignored path moving it into the folder | FUSE tests with real git (the pinned version): a file and a folder ignored by the top `.gitignore`, by one in a subfolder, and by `info/exclude`, never published; a negated pattern published; a tracked path under an ignored pattern published; `git add -f` of an ignored file and folder published at the next boundary; an editor's atomic save over a published file from an ignored temporary name, and over an ignored file from a plain one; a changed `.gitignore` deciding only new names; the cases checked against `git check-ignore` |
| MC3a | Folder program: `--cache-dir` (its checks, its layout, an old cache under `--local-dir` let go), several programs on one cache folder (above), and the kernel cache with its start-up check, its telling and its fall-back; the speed test; a new build record and the installer pins | FUSE tests: a cache folder another account could use refused; the kernel cache on only where the start-up check allows it (a test switch stands for the kernel's answer); two programs on one cache folder, each change of one (write, truncate, create, rename, unlink, rmdir, a file crossing the edge) shown by the other at once, through a held fd too; an open keeping pages only of a file as it was; a notify that fails, a program that does not answer (in time, with `EIO`) and a message that is no change each turning the kernel cache off or dropping all; node files still handed over; a shared mapping showing a change within 10 s; a cache top the node took unheard gone from every program at the resync; a held folder's names gone with its cache top; the name filter: a name looked up absent, a listed name removed, a lookup that read the disk just before another program's create or removal, a full table (a test switch makes it small), a folder renamed under a walked path and a rename onto a name seen absent, each shown at once, and names the kernel never held changed without an epoch; two programs changing one file and one folder 500 times at once, in bounded time, with mutants (an answer that drops pages or an entry first) caught; unit tests for the shared cache folder (each program's own `gone/`, no program taking another's caches, the seal and another program's write handle). The speed test by hand on a node, its table in the PR body |
| MC3a end | Folder program: at its end, every request refused, then the kernel's pages of every inode ever opened dropped, then the unmount and the exit ("At the end"); a new build record and the installer pins | FUSE tests: at the view's close, and at a SIGTERM after 3000 more cache files were opened, a process holding read fds on a node file and a cache file, a never-read fd on a file another process read, fds on a node file and a cache file it made and wrote, a folder's fd it opens names through, a shared mapping read once and a shared writable mapping written: after the end every read, `stat` and `openat` fails, the mapping's next touch (in a child) gets `SIGBUS`, the written page's `msync` gives `EIO` and the disk never has it; a `statfs` asked over and over gets the refusal through the end, then `ENOTCONN` or `ECONNABORTED`; the drop's time in the log, under 10 seconds. A SIGTERM during a fall-back's end (its drop held at a test gate) neither unmounts nor exits before the drop is done; a create at the node and one in a cache, let through before the end and answered after its drop, open nothing (`EIO`); a hard link to a cache file a process holds open, answered after the drop, gives that fd no attributes (its `stat` fails during the end and after it). Mutants (no drop, attributes only, no refusal, an open or a create not noted, a second end that does not wait, a create's attributes kept, a link's attributes kept) caught |
| MC3b | Folder program: removing old caches by top entry, with their records and locks (below) | FUSE tests: removal of an unused cache folder, of the least recently used when the disk is short (the test gives a size limit in place of the disk's free space), never of an open folder or an open top cache file, and of one whose parent is gone; an ignored file and an ignored folder at a worktree's top (each its own top entry) kept past 14 days and when the disk is short, the writer then getting `ENOSPC`, and removed with their worktree; a mount started again finding its cache |
| MC3c | The key on company machines (the folder helper passes `--cache-dir /var/lib/qorpera-folder/cache/desktop` for a desktop and `cache/<owner>` for a command; decision 1, with migration 20260930516000), and per machine on coding and test machines (their setups pass it); the office's node e2e. Updates RUNTIME-FOLDER-COMPANY-MACHINES.md "Mounts in the VM". Session 39's | The helper's tests: `mount` passing `cache/desktop` for every desktop of the machine, a command's owner's cache folder, one for one owner's commands and another for another owner's, a desktop and a command each refused the other's cache, and the cache kept past the mount and the helper; SQL test 538: a desktop view's authority the same for each kind of holder, and a company-wide view whose agent or member lost the root read not renewed; the office's node e2e ([`../test-machine/OFFICE-FOLDER-CACHES.md`](../test-machine/OFFICE-FOLDER-CACHES.md)) |

**Order.**
- MC1 builds on 5d's local layer, so it starts once #1096 has merged. It changes the same program files as LK4 (links),
  so it comes after LK4 too.
- MC2 needs MC1's table and 5d's index reader. MC3a needs MC2 (merged), MC3b needs MC3a, and MC3c (the helper and
  the setups) takes the flag MC3a adds, so it merges after MC3a. MC3c changes step 4's folder helper (its owner,
  qorpera-80, is gone; the coordinator took the notice on 18 October).
- MC3a end is stacked on MC3a and merges after it, before the v183 cut; MC3a does not wait for it.
- Step 4's acceptance (4g) shows item 8 on company machines (amendment item 10), so 4g waits for MC1 and MC3. Step
  6's 6e waits for item 8's caches in the program (RUNTIME-FOLDER-TEST-MACHINES.md, Order). A test machine builds in
  worktrees, where 5d's cache already holds; MC3 makes that cache outlive the machine's mounts.
- MC3c (the helper and the setups) carries migration 20260930516000 and SQL test 538 (decision 1, amended), and the
  office's node e2e: [`../test-machine/OFFICE-FOLDER-CACHES.md`](../test-machine/OFFICE-FOLDER-CACHES.md) (the caches
  on the disk, each owner's apart, found after a restart, and a closed view's end within its bound). It passes only
  with MC3a's program pinned.

**Deploy.** The folder program ships in the coordinator's node release and the images, with a new build record
(`deploy/folder-service/folder-program-linux-x64.json`) and the installer's pin in MC1, MC2, MC3a, MC3a end and MC3b. MC3c's
folder helper ships with the runtime.

**Deferred (needs Codex).** None of these slices needs a model. Each step's acceptance run (4g, 5's and 6f) shows a
real install on a live machine.

## Decisions

The coordinator chose the first option of each question on 15 October. The plan above builds them.

1. **The key on company machines** (above), amended by the coordinator on 18 October (MC3c): a cache made in one view
   never shows in a view of different authority. Desktop views share one authority, so a machine's desktops share
   `cache/desktop`. Commands and member views are one cache per owner. A build's output can hold the text of the files
   it read, so a cache made in one authority's view must not reach another's. Not chosen: one cache per machine for
   everything, as on coding machines; nor one per desktop holder, which a takeover would empty.
   Why every desktop view has the same authority, on master's code:
   - a desktop view opens only while the screen's agent and the view's member both read the root resource:
     `20260928259230_folder_core_views.sql` lines 335-399, the refusal at 394-399; the root read is
     `qorpera_folder_reads_root`, `20260928549400_folder_test_machine_views.sql` lines 40-49;
   - its actor's view is company-wide: 20260928259230 line 206 (later kinds: 20260928539120 lines 215-218,
     20260928549400 lines 110-111, 20260928559230 line 150);
   - a company-wide actor reads only paths whose covering resource is the shared root, or `rules/`, on top of its own
     authority: 20260928259230 lines 258-288, the check at 264-266 (20260928469130 line 738 only adds a worker
     report's write after it);
   - and since 20260930516000 it renews only while both still read the root. A member loses the root read only by
     leaving the company; an agent, when its grant is revoked or lapses, or the root's version changes.
   SQL test 538 pins the set for each kind of holder (a run, no one once the run let go, a read-only worker's run, a
   member's takeover, a viewer's takeover) and fails if a desktop view could ever read less or more.
2. **The name lists: rules 2 and 3 as written.** `vendor` and `.yarn` stay out, because projects often commit them. A
   name added later is a one-line change in the program; a name dropped would leave existing caches where they are
   (rule 6).
3. **Git repositories outside code areas: `.git` stays refused outside `code/`** (today's rule). Repositories live in
   code areas, where git's rules decide. Not chosen: a `.git` outside `code/` as a cache, whose history would stay on
   one machine.
4. **Ignored files and folders: both are cache in a worktree.** That is the amendment's words ("what its `.gitignore`
   leaves out"), and it keeps a `.env` or a `*.log` on the machine. Not chosen: only ignored folders as cache.
5. **The speed fix: a kernel cache for cache files** (the coordinator, 18 October; "The kernel cache"). On a node
   (kernel 7.0, FUSE 7.45) a load of 3000 small modules took 181 ms on the plain disk, 930 ms with MC2b's caches, 928
   ms with FUSE passthrough and 310 ms with a kernel cache. Not chosen: passthrough, which saves little here (each
   `stat` and `open` still reaches the program), fails a plain open with `EIO` while a passthrough open of the file is
   held, and sends writes past the program, so a seal or a removal no longer sees them.
