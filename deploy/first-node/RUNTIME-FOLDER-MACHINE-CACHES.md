# Dependencies and builds on the machine: the plan

Status: plan, for review before it is built. It builds the contract's "2026-10-14 amendment: machines work in the
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
tracks it. The cache outlives the mount and the command, so the next command on the machine does not install again.
Old caches are removed when unused or when the disk runs short.

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
   Repositories live only in code areas: `.git` stays refused outside `code/` (question 3 below).
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
    (an editor writing `notes.md.tmp`, then renaming it over `notes.md`, in a repository that ignores `*.tmp`);
  - a new pending file (made in this view and never published) renamed onto a cache path moves into the cache, and
    leaves the view's pending changes. The same atomic save works the other way round (`.env.tmp` over `.env`, which
    git ignores).
- **A published folder holding a cache:**
  - `rmdir` sees the cache entries, so it answers `ENOTEMPTY` until they are gone; `rm -r` removes them first;
  - renaming the folder moves its cache with it, once the folder service has taken the rename;
  - when the folder goes from the view in another way (another machine removed or moved it), its cache folders are
    dropped.
- **Boundaries** do not wait for cache files: a cache file open for writing holds up nothing.
- **A full disk** answers `ENOSPC` to the writer, as a local disk does.

## Where the cache lives

The cache is a folder on the machine's disk, owned by the folder program's user and closed to every other user. The
program serves its files through the mount, so the processes that use them need no access to the folder itself. It
is never under `/run`, which empties at every start and is memory.

- A new flag, `--cache-dir <dir>`, names it. 5d's `--local-dir` keeps the session's own git files (§6: they are seeded
  again when another view finds them). The cache moves out of it, because a cache is shared by several mounts and a
  session's git files are not.
- **Who passes it** is the trusted side that starts the program: on company machines the folder helper
  (`cloud-company-computer-folder-helper.ts`, step 4), on coding machines the coding setup (step 5), on test machines
  6d's guest. Without the flag, the program keeps its cache under `--local-dir`, for that mount only (5d's behaviour).
- **The key.** Company machines carry many owners: desktop holders change, and every offline command gets a view and
  a mount of its own (4b). A cache made from one owner's files must not show in a view of another owner with a
  narrower authority. So:
  - **company machines:** one cache per owner on the machine: `/var/lib/qorpera-folder/cache/<owner>`, where the
    owner is the agent of an agent's view, or the member of a member's view. A desktop's mount and all of one agent's
    commands share it, so `npm install` in one command and `npm test` in the next work as on one disk;
  - **coding and test machines:** one cache per machine. Root inside the machine already joins its sessions (contract
    item 11, "Root makes one member's sessions on one machine no walls between each other"), so walls between their
    caches would protect nothing;
  - question 1 below asks whether company machines should share one cache per machine as well.
- **Several mounts at once.** Several folder programs can serve one cache folder at a time (a desktop and two commands
  of one agent). So a cache file has no kernel cache of its own (time-outs of zero for its names and attributes, and
  no kept pages), and every request reaches the program, which asks the disk. A process sees what another mount wrote
  at once, as on one disk. What two programs run at once in one project (two `npm install`s) is the user's business,
  as on any disk.

## Removing old caches

The program removes old caches when it starts and once an hour while it runs:
- a cache folder at the top of a cache (each `node_modules`, `dist` and so on) unused for 14 days goes;
- when the disk has less than 10% free, the least recently used go first, until 15% is free;
- a cache folder that any program has open is never removed: each program holds a shared lock on each top cache
  folder it serves; removal takes it exclusively without waiting, and skips the folder when it cannot;
- a cache folder whose published parent is gone (rule above) goes at the next pass.
"Used" is kept in a small file per top cache folder, beside the cache and outside every mount, updated at most once an
hour. A removed cache is built again by the next install or build, as on a fresh machine.

## What does not change

- **The core and SQL.** Nothing: a cache never reaches the core. The core's refusal of `node_modules` outside `code/`
  stays as the last check. No migration and no SQL test.
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
| MC3 | Where the cache lives: `--cache-dir`; no kernel cache for cache files; the per-owner key on company machines (the folder helper passes `--cache-dir /var/lib/qorpera-folder/cache/<owner>`), and per machine on coding and test machines (their setups pass it, if they are on master by then, else they take the flag in their own slice); removing old caches with its locks. Updates RUNTIME-FOLDER-COMPANY-MACHINES.md "Mounts in the VM" | FUSE tests: two mounts on one cache folder, a write in one read at once in the other; a mount started again finding its cache; two owners' mounts not seeing each other's cache; removal of an unused cache, of the least recently used when the disk is short (the test gives a size limit in place of the disk's free space), never of an open one, and of one whose parent is gone; the helper's tests: `mount` passing the owner's cache folder for a desktop and a command, the same for one agent's desktop and commands, another for a member's view |

**Order.**
- MC1 builds on 5d's local layer, so it starts once #1096 has merged. It changes the same program files as LK4 (links),
  so it comes after LK4 too.
- MC2 needs MC1's table and 5d's index reader. MC3 needs MC1, and its helper part changes step 4's folder helper
  (owner qorpera-80 is told first).
- Step 4's acceptance (4g) shows item 8 on company machines (amendment item 10), so 4g waits for MC1 and MC3. Step
  6's 6e waits for item 8's caches in the program (RUNTIME-FOLDER-TEST-MACHINES.md, Order). A test machine builds in
  worktrees, where 5d's cache already holds; MC3 makes that cache outlive the machine's mounts.
- No migration slot and no SQL test are needed.

**Deploy.** The folder program ships in the coordinator's node release and the images, with a new build record
(`deploy/folder-service/folder-program-linux-x64.json`) and the installer's pin in MC1, MC2 and MC3. MC3's folder
helper ships with the runtime.

**Deferred (needs Codex).** None of these slices needs a model. Each step's acceptance run (4g, 5's and 6f) shows a
real install on a live machine.

## Proposals and questions

These need the coordinator's choice before MC3 (question 1) and MC1 (questions 2 to 4). The plan builds the first
option of each unless told otherwise.

1. **The key on company machines.** (a) One cache per owner on the machine (above): a cache made from one agent's
   files never shows in another agent's or a member's view. A takeover by a member starts with an empty cache, and the
   next install is slower. (b) One cache per machine, as on coding machines: faster, but a build's output (which can
   hold the text of files it read) shows to every holder whose view reaches the folder.
2. **The name lists.** Rules 2 and 3 as above. A name added later is a one-line change in the program; a name dropped
   would leave existing caches where they are (rule 6).
3. **Git repositories outside code areas.** (a) `.git` stays refused outside `code/` (today's rule): repositories
   live in code areas, where git's rules decide. (b) A `.git` outside `code/` is a cache: `git init` works anywhere,
   but that repository's history stays on the one machine and is never published.
4. **Ignored files and folders.** (a) In a worktree, files and folders that git ignores are both cache (the
   amendment's words: "what its `.gitignore` leaves out"). So a `.env` or a `*.log` stays on the machine. (b) Only
   ignored folders are cache, and ignored files are published.
