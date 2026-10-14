# Links in the company folder: the plan

Status: plan, for review before it is built. It builds the contract's "2026-10-14 amendment: machines work in the
folder as on their own disk", items 4 (symbolic links), 5 (hard links) and 6 (devices, pipes and sockets), and the
line of its "For the build" list that says links need a new entry kind in the core (versions, change-set units, the
feed, history and restore), the write protocol, the folder program (`symlink`, `readlink`, `link`), the folder service
and the server-side tools, and that git's `core.symlinks` becomes true. The design's side is
[RUNTIME-COMPANY-FOLDER.md](RUNTIME-COMPANY-FOLDER.md), "Decided on 14 October 2026" and §3 "What the mount shows". It
extends the core ([RUNTIME-COMPANY-FOLDER-CORE.md](RUNTIME-COMPANY-FOLDER-CORE.md) §3), the read path
([RUNTIME-FOLDER-SERVICE.md](RUNTIME-FOLDER-SERVICE.md)), the writes
([RUNTIME-FOLDER-WRITES.md](RUNTIME-FOLDER-WRITES.md)) and the company machines' reads
([RUNTIME-FOLDER-COMPANY-MACHINES.md](RUNTIME-FOLDER-COMPANY-MACHINES.md), "Reads"). Facts about today are from master
at 98e29ed49.

Today the core knows three kinds (`file`, `folder`, and `claim` for a path being made) and six units (`write`,
`mkdir`, `new_folder`, `delete`, `move`, `copy`). The folder program answers `symlink`, `link` and `mknod` with
`EPERM` (`EROFS` on a read-only mount), and the writes plan lists links under "Errors at once" until these slices land.

## What the slices deliver

On a machine that carries the folder, `ln -s`, `readlink`, `ln` and every program that makes or reads links work in
`/company` as on the machine's own disk. A symbolic link is an entry of its own kind, with its target text and a
version history; the folder keeps it, moves, copies, restores and deletes it like a file, and never follows it. A hard
link makes a copy stored once, and the two names keep their own versions. Devices, named pipes and sockets stay
refused. The core, the folder service, `company_list`, `company_read` and `company_search` show a link as a link, with
its target, and git keeps links as links.

## The rules

**A symbolic link** (contract item 4):
- **Its target is text, kept exactly.** 1 to 4,095 bytes of UTF-8 (the kernel's own bound is 4,095), with no NUL.
  Nothing else about it is checked: relative or absolute, `..`, a name the folder forbids, a path outside `/company`, a
  path that does not exist. The core never normalizes it and never resolves it.
- **The folder never follows a link.** No path goes through one: a path whose parent is a link is absent to every
  reader, and a save there has no parent (`parent_missing`). Listings, reads and searches show the link itself. A
  search never walks through a link, and `**` in a glob does not go into one.
- **Only the kernel follows links, on the machine.** A target inside `/company` resolves through the same mount, so
  through the reader's own view, and a path that view cannot read does not exist there. A target outside `/company`
  names the machine's own files. So a link never widens what anyone may read (item 4).
- **Its own name is a name like a file's.** The folder's name rules (`EINVAL`), the adapter-only names (`.qorpera`,
  `.git`, `trail`, `inbox`, `credentials`, `secrets`, `node_modules`; code areas excepted), the case-only rule
  (`EEXIST`) and the path bounds apply to it ([RUNTIME-COMPANY-FOLDER.md](RUNTIME-COMPANY-FOLDER.md) §2, "Errors that
  happen at once").
- **Reading its target is reading its content.** It counts as a read of the link's path at its version, as a file's
  bytes do; seeing its name in a listing is a listing, as for a file. A link carries no
  executable bit and no bytes in storage.
- **Making or changing one is a save like any other** (item 4): the same write authority, and the review a write at
  that path would take. A delete or move of a link is a deletion like a file's, which an in-house agent's view parks
  as a proposal (P40). When a company configures a protected path (none is configured by default), a link under it
  proposes as a write does.
- **A link never stands where the core reads company state.** A structured file's path (contract 5.6,
  `qorpera_structured_path_kind`), a structured folder's place (an agent's or group chat's folder, `routines/`,
  `todos/`, a todo's or worker's folder: `qorpera_structured_folder_names`) and a summary tree's platform-only paths
  hold no link: the core parses those as files and folders, and a link has nothing to parse. A unit that would put one
  there, by a move or copy of a link or of a folder holding one included, is refused (`structured_invalid`, its
  problem saying a link cannot stand there).

**A hard link** (item 5) is a new name with the source's content as the view showed it, stored once: a `write` of the
new name with the file reference of the source's version. The core already lets an actor reference bytes it may read
([RUNTIME-COMPANY-FOLDER-C1D.md](RUNTIME-COMPANY-FOLDER-C1D.md) §3, "Possession before reference"), so the core needs
nothing new for it, and GC keeps the bytes while any version names their manifest. The two names are never joined: each has its
own versions, readers and history, and a save to one never changes the other. On the machine each name is its own
inode with one link. A hard link of a symbolic link (`link(2)` does not follow it) is a new symbolic link with the
same target. Making one is a read of its source.

**Devices, named pipes and sockets** (item 6) stay refused (`EPERM`), as today: `mknod` of any type, `mkfifo`, and a
Unix socket bound in `/company`. Programs keep them in `/tmp` or elsewhere in the machine's scratch.

**History, restore, erasure and GC.**
- Each change of a link is a path version of kind `symlink` holding its target; the history of a path shows a link's
  versions with their targets, across changes of kind (a file replaced by a link and back).
- Restoring a link's old version is a save of its target, through the member commit route like a file's restore
  ([RUNTIME-FOLDER-WRITES.md](RUNTIME-FOLDER-WRITES.md), "Restore in the web app").
- A link's conflict is kept on the run's receipt as a file's is: a conflict copy holding the losing target.
- Erasing a path erases its links' versions, targets and conflict copies with it. A link elsewhere whose target names
  an erased path keeps its target, as a document that mentions the path keeps its text. A hard link is a copy:
  erasure's copies warning names it as a copy elsewhere holding the erased bytes, as for any copy.
- GC is unchanged: links hold no bytes, and hard links share a manifest that GC already roots per manifest.

**What stays different from a local disk** (item 9, and item 5's own choice): a save through one of two hard-linked
names does not show through the other; `stat` shows each with one link; and a link's owner, mode and times are the
folder's, as a file's are (a `touch -h` or `chmod` on a link changes nothing and is not an error).

## The core (LK1)

| Change | What |
| --- | --- |
| Kinds | `symlink` on entries and path versions, with a `target` column that only a link's rows hold |
| New unit | `{op: "symlink", path, target, expectedVersion?}`: without `expectedVersion` the path must be absent (`exists`); with it the unit replaces the file or link at that version, never a folder (`version_changed`). Its path version is op `write`, kind `symlink`, chained to the version it replaced |
| `write` | with `expectedVersion`, may replace a link at that version (a file renamed over a link on a machine) |
| `new_folder` | its contents may hold `{path, kind: "symlink", target}` |
| `move`, `copy`, `delete` | carry links, a folder's links included; a copy of a link is a link with the same target |
| Authority | a `symlink` unit needs write authority on its path. The commit's authority chain refuses any op that has no check of its own, so an op added later can never pass unchecked |
| Structured paths | the hooks refuse a link at a structured path, a structured folder's place and a summary tree's paths; every structured check says what it does with a link, and none lets an op it does not know through |
| Review | a `symlink` unit takes a write's review class at its path (plain, since links never stand at structured paths); a `new_folder` holding links takes the folder's |
| Conflicts | a link's conflict is kept on the run's receipt as a file's is (the contract keeps every conflicting version there): a conflict copy of kind `symlink` holding its target, for a `symlink` unit and for each link of a conflicting `new_folder`, beside its files (P17). `qorpera_folder_conflict_copies` takes `kind` and `target` (a link's copy has no file columns), and `qorpera_folder_conflict_copies_of` lists each copy's kind and a link's target. A link's copy holds no bytes, so storage and GC are unchanged |
| Reads | `qorpera_folder_read`, `qorpera_folder_list`, the feed and member history give `target` for a link, and only for a link. A read of a link's version is released and rechecked as a file's is |
| Erasure | removes a link's versions, targets and conflict copies with its path; no stored outcome, proposal or journal row keeps a target after it |

Migration `20260930380000` (wave-4 claim, registry 14 October 15:51Z). It patches `qorpera_folder_commit` and its
neighbors by anchor, with `pg_temp.lk1_replace` counting each anchor's occurrences, as `pg_temp.m1a_generation_replace`
does in migration `20260928509140`, and replaces no whole function another open PR changes.

## Protocol 4 (LK3)

A machine that knows links says `protocol: 4` in its hello. Protocol 4 is protocol 3 with links: a core view takes
writes from protocol 3 or 4, and a protocol 4 hello carries what a protocol 3 hello does (#1018's `abandon` included).

- **Listings** give a link as `{name, kind: "symlink", size, mtimeMs, executable: false, version}`, `size` being its
  target's length in bytes (what `lstat` shows). The listing carries no target, so a page of 1,000 entries stays small.
- **`R`** on a link's version (the current one, or one of the last 16, as for a file) answers its target's bytes.
- **Search** (`S`) finds a link by its name, never by its target, and never walks through it. A link's hit has
  `kind: "symlink"` and its `target`, and the link is in the page's `reads` with its version.
- **Below protocol 4** a machine never sees a link: listings and search leave links out, `R` on a link's version is
  `NOT_FOUND`, a name a link holds is taken (`EXISTS`), and a folder holding a link is not empty (`NOT_EMPTY`).

New requests on a writing connection, each answered with `k` or `e`:

| Type | Request | Answer |
| --- | --- | --- |
| `Y` | symbolic link `{path, target}` | `k` `{version}`; `EXISTS` when the path is there, `BAD_REQUEST` for a target outside the rule |
| `J` | hard link `{from, fromBase?, to}`, naming its source as `N` does (`fromBase` the version the machine showed) | `k` `{version}`; `EXISTS` when `to` is there; `STALE` for a base no longer served; `BUSY` while the source is open for writing in the view (P1); `NOT_PERMITTED` for a folder |

How the service turns them into units at a boundary, with its pending changes (3c's rules otherwise unchanged):
- `Y` makes a pending link. A pending link can be read (`R` on the `version` `Y` answered), renamed and removed like a
  pending file, and the version map takes its version as it takes a close's.
- `ln -sf` (a link made under a temporary name, then renamed over the name) is one `symlink` unit with the replaced
  version. A file renamed over a link is a `write` with the link's version; a link renamed over a file, a `symlink`
  with the file's. Removing a link is a `delete` with its version, and a rename of a live link a `move`.
- A link inside a new folder goes into that `new_folder`'s contents.
- `J` stages the new name from the source's version as a file whose bytes are still its origin's (as a `C` of an
  unchanged file does): no byte is sent or stored again, and the boundary sends a `write` of that file reference. From
  a pending source it takes the pending file's staged reference; from a link it makes a pending link with the same
  target.
- A link whose name is never published (an editor's lock link such as Emacs's `.#name`) stays pending, as such a
  file does. A refused link stays pending, as a file's change does. A conflicting link is kept on the receipt as a
  file is: the view lets it go only once `qorpera_folder_conflict_copies_of` lists it, and its report line says it was
  kept and carries its target.

The member commit route (`packages/object-gateway/src/member-folder-commits.ts`) and the member's client take a
`symlink` unit, so a member's restore of a link's old version and P27's web file page can save one.

## The folder program (LK4)

- **Kinds.** A link is `FileType::Symlink`, mode `0777`, one link, size its target's length.
- **`readlink`** reads the target with `R` and logs a read of the link's path and version before it answers, as an
  open is logged (4c). `FUSE_CACHE_SYMLINKS` stays off, so every `readlink` reaches the program and a run that took
  over the mount (a `switch`) has its own reads logged.
- **`symlink`** sends `Y`; the link's own name follows the file name rules. A target that is not UTF-8 is `EINVAL`
  (the kernel refuses an empty target and one over 4,095 bytes before the program sees it).
- **`link`** sends `J` with the source inode's version as `fromBase`, after logging a read of the source, and answers the new name
  as a new inode with one link. The kernel takes a new node id in `link`'s reply as long as its type matches; LK4
  proves that on the test machine before anything else. If it does not, LK4 tries the kernel's other routes (the
  source's node in the reply, then the new name's entry dropped so its next lookup finds a node of its own); if none
  works, it stops and reports to the coordinator with the evidence, since `link` is item 5 and a gap there needs
  Jonas's word.
- **`setattr`** on a link keeps nothing and is not an error (times and modes are the folder's).
- **`mknod`** stays `EPERM` for every type (`EROFS` on a read-only mount).
- **Read-only mounts** answer `symlink` and `link` with `EROFS`, and show links.

## The server-side tools and the web app (LK2, LK5, LK6)

- **`company_read`** of a link answers `{path, kind: "symlink", version, target}` and releases the read, as for a file.
  A path through a link is absent.
- **`company_list`** shows a link's `target` on its row. It already releases every entry it shows with its version,
  which covers the targets shown.
- **`company_write`** refuses a link's path: the answer names the target, and the agent writes to the path it names.
  **`company_delete`** of a link deletes the link itself. **`company_mkdir`** at a link's path is `exists`.
- **Skills, routines and interfaces** never follow a link: a skill's `SKILL.md` that is a link is not loaded, as a
  missing one is, and an interface serves no link.
- **`company_search`** (LK5) says protocol 4 to the folder service, shows a link's hit with its target, and releases
  the link's read with the page, as for any hit.
- **The web app** lists a link with its target (`→ target`) from LK2, so it never breaks on one. LK6 shows a link in
  the member's file page (its target, no bytes) and history (each version's target, across changes of kind), and its
  restore button saves an old version of a link with the `symlink` unit through the member route, as P27's restore
  saves a file's. LK6 reuses the web's file page and history parts and builds no new ones.

## Git

`core.symlinks=true` is already in the settings every session runs with
([RUNTIME-COMPANY-FOLDER.md](RUNTIME-COMPANY-FOLDER.md) §6, "Settings every session runs with"), which outrank a repository's own config; the per-session git settings are
built with step 5 (coding machines), not here. Git on Linux defaults to `true`, and `git init` and `git clone` keep it
once their probe link works, which LK4 brings. A checkout writes a mode-120000 entry as a link. A clone from a path
hard-links its objects: it copies them where `link` fails, except when `--local` was asked for, which then fails.
LK4's FUSE tests run a checkout with a link and `git clone --local`.

## Slices

Each is its own PR with an exact-head review. Readers come before writers: LK2 is live before LK3, so every reader of
the folder knows a link before anything can make one. LK1's SQL alone lets no caller make a link (the member route
refuses every kind but a file until LK3, and no tool makes one). LK3's service is live on both nodes before LK4's
program reaches any image, and before LK5. LK6 follows LK3. Step 4's image (4e) does not wait for LK4: it ships the
folder program that exists then, and a later image generation carries LK4 (the coordinator rolls images).

| Slice | What | Tests |
| --- | --- | --- |
| LK1 | SQL: the core (above). Migration `20260930380000`. Updates RUNTIME-COMPANY-FOLDER-CORE.md §3's units and kinds | 460: a link made with targets kept exactly (relative with `..`, absolute, outside `/company`, with spaces, 4,095 bytes), read, listed, in the feed and member history with its target; an empty target, one of 4,096 bytes and one with a NUL refused as an invalid unit; a `symlink` on a present path without a version `exists`, with a file's version replacing it (kind `symlink`, prior version chained), with a folder's refused; a `write` with a link's version making it a file again; a path under a link absent to `qorpera_folder_read` and `parent_missing` for a save; move, copy and delete of a link and of a folder holding links; a `new_folder` with links; a `symlink` unit without write authority `denied`; a reserved name refused for a link; a link refused at `agents/<a>/agent.md`, at `agents/<a>` and in a summary tree, and a move or copy of a link or of a folder holding one into those places refused; a view's read of a link released and rechecked; a hard link (a `write` of another path's file reference) stored once, and each name's next save changing only that name. 461: an in-house agent's view's `symlink` unit lands (plain), its delete and its move of a link are parked (P40) and land on review, and a new agent folder holding a link is parked with it; a `symlink` unit's conflict keeps the losing link on the receipt (`qorpera_folder_conflict_copies_of` lists it with kind `symlink` and its target), and a conflicting `new_folder`'s copies keep each of its links beside its files; after erasing a link's path no table holds its target text, its conflict copies included, and a link elsewhere naming the erased path keeps its target; GC keeps bytes two names share until both are gone |
| LK2 | Runtime and web, readers only: the client parses `symlink` with `target`; `company_read`, `company_list`, `company_write`, `company_delete` and `company_mkdir` as above; skills, routines and interfaces never follow a link; cloud-client and the web's folder list: a link's row with its target | the runtime's tests with a stand-in folder: a link read (kind, target, version, released), a path through a link absent, a list page with a link's target and its release, `company_write` refused on a link with its target named, `company_delete` of a link deleting the link, a skill whose `SKILL.md` is a link not loaded, an interface not serving a link; cloud-client's parser taking a link and its target; the web's tests: a link's row with its target |
| LK3 | Folder service, protocol 4 (above): listings, `R`, search, `Y`, `J`, pending links and their units; links hidden below protocol 4; the member commit route and client take `symlink` | the service's tests with the stand-in core and gateway: the hello at 4, and #1018's fields at 3 and 4; at protocols 1 to 3 no link listed or found, `R` on one `NOT_FOUND`, a folder holding one not empty; at 4 a link listed with its size, `R` serving its target at the current and a replaced version; `Y` making a pending link that reads back, `EXISTS` on a present path; `ln -sf` as one `symlink` unit with the replaced version; a file renamed over a link as a `write` with its version, and a link over a file as a `symlink` with the file's; a removed link as a `delete`, a renamed one as a `move`; a link in a new folder in its contents; `J` from a live file as a `write` of the source's reference with no bytes put, from a pending file with its staged reference, from a link as a link with its target; `J` from a file open for writing `BUSY`, onto a present name `EXISTS`, naming a version no longer served `STALE`; a lock link never published; a refused link kept pending; a conflicting link (alone, and in a new folder) kept in the view until the receipt lists it, then reported as kept with its target; the 3c boundary model, links included, ending as the view showed it; search: a link found by name with its target and its read, never by its target, and never walked through; the member route's tests: a `symlink` unit saved, a target over 4,095 bytes refused. `scripts/test-folder-core-acceptance.mjs`'s F3-LK lines on the hosted database: a boundary with `Y`, `J` and an `ln -sf` committed by the real core |
| LK4 | Folder program: `symlink`, `readlink`, `link` (above); a new build record and the installer pins. First, the probe of `link`'s reply on the test machine | FUSE tests on the test machine: `ln -s` (relative and absolute), `readlink`, `ls -l`; reading through a link to a file in the view, and to a path the view cannot read (`ENOENT`); a link to a machine file outside `/company`; `ln -sf`; `mv` and `rm` of a link; `cp -a` and `tar` of a folder with links keeping them; `ln a b`, then a save to `a` leaving `b` as it was, each with one link; `git clone --local` of a repository in the folder; a checkout of a commit holding a mode-120000 link; Python's `os.symlink`, `os.link` and `os.readlink` and Node's `fs.symlink` and `fs.link`; `mkfifo`, `mknod` and a Unix socket's bind `EPERM`; a non-UTF-8 target `EINVAL`; `EROFS` on a read-only mount; each `readlink` logged as a read of the link's path and version, released before the next publish, and logged again after a `switch`; a hard link logged as a read of its source |
| LK5 | Runtime: `company_search` says protocol 4 and shows link hits (above), once LK3 is live on both nodes | the search tool's tests with a stand-in service: the hello at 4, a link's hit shown with its target, its read released with the page |
| LK6 | Web, after LK3: a link in the member's file page and history, and the restore of a link's old version (above), in the web's existing file page and history parts | the web's tests: a link's file page showing its target and fetching no bytes; its history listing each version's target, a file's versions and a link's on one path; restoring a link's old version sending a `symlink` unit with the current version as `expectedVersion`, over a current file too (the file's version), and a file's old version restored over a current link as a `write` with the link's version |

**Live proof.** Step 4's acceptance (4g) shows links on a company machine (contract item 10: "its acceptance shows
it"); the coordinator runs it, on the image generation that carries LK4. From a computer's shell: `ln -s ../reports/latest.csv today.csv` and reading through it;
`ln -sf` to another target, landing as one change of the link, the web app's history showing both targets; `ln` of a
large file, landing at once with no bytes sent, and a save to one name leaving the other as it was; `git clone` of a
repository with links, `git status` clean after it; `npm install` into the machine's own cache is item 8's, not this
plan's. The other node's machine sees each link within about a second.

**Deferred (needs Codex):** an agent's run that makes a link on a company machine and then reads it with
`company_read`, `company_list` and `company_search`; an in-house agent's deletion of a link parked as a proposal and
reviewed in its next run.

**Settled in the implementation.** This plan fixes the rules and the tests above. How each slice builds them is
designed in its PR and reviewed there against these rules: the core's columns, indexes and anchors (LK1); the
service's pending links and their place in the boundary plan (LK3); the program's version map and read log entries
for links (LK4); which web parts show a link (LK6). A case a slice's review finds that these rules already decide is fixed in that slice, with a test;
this plan changes only if a rule is wrong.

## Proposals and decisions

Proposals, left for after 4g:
- **P1.** A hard link of a file open for writing in the view is `BUSY` (LK3). On a disk it works. If a tool needs it
  (4g shows), `J` could publish the open file's last close first, as a change that must publish first does.
- **P2** is no longer a proposal: the contract keeps every conflicting version on the run's receipt, so LK1 keeps a
  link's (above).
- **P3.** Every `readlink` is logged. If 4g's numbers show the log's cost (a `node_modules/.bin` walk reads many
  links), the program could log a version once per view.

Decided by the coordinator, 14 October 2026:
- **The web's restore button for a link is this plan's** (LK6, above), not P27's; the Interfaces session keeps its own
  list, and LK2 and LK6 name the web files they change to it before they start.
- **4e's image does not wait for LK4.** Images can roll more than once; a later image generation carries LK4, and 4g
  waits for that generation.
- **If LK4's probe of `link` fails,** LK4 tries the kernel's other routes, and if none works it stops and reports to
  the coordinator with the evidence. It does not record a difference from a local disk itself: `link` is item 5 of
  the amendment Jonas approved, so a gap there needs his word.
