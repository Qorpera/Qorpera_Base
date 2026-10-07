# Writes through the mount (F3 step 3): the plan

Status: plan, for review before any of it is built. The design it follows is
[RUNTIME-COMPANY-FOLDER.md](RUNTIME-COMPANY-FOLDER.md) §2 ("Writes: change sets") and its build order (step 3), as
the 2 October amendment "light threads" changed them. The read path it extends is
[RUNTIME-FOLDER-SERVICE.md](RUNTIME-FOLDER-SERVICE.md) (step 1, #647). Where this page differs from §2, it says so
and why.

## What step 3 delivers

A program on a machine changes files under `/company`, and the change lands in the company folder as change sets:
new and changed files, new folders, moves, renames and deletes, each with its outcome reported back. Two machines on
two nodes can edit the same folder, and a same-path edit becomes a conflict, never a lost write.

Since light threads, no chat turn has a shell. The writers are machines: company machines (step 4), coding machines
(step 5) and test machines (step 6). Step 3 builds what all three share: the write protocol, the folder service's
pending changes, staging, publishing and the report. Each later step adds its view kind, where its boundaries come
from, and who its saves are credited to.

**Who writes in step 3.** The mounts step 1 configures by hand (an operator's mount of a member or the platform),
now read-write. A member's and the platform's units pass no automatic review (contract 5.6), so step 3 needs none.
A view whose saves would need review (an agent's: a company machine's holder, a shell command's run, a coding session,
a test machine's command) stays read-only until its step wires review in. So nothing skips review on the way.

**Not in step 3:** review of an agent's deletes, moves and delegation units, and proposals (steps 4–6, with the run
that owns the view); per-command attribution (steps 4 and 6); desktop notifications (step 4); code areas (step 5);
restore in the web app (the Interfaces session's file page; below).

## The parts

| Part | Step 3 adds |
| --- | --- |
| Folder program (`crates/qorpera-folder`, in the machine) | write operations; the bytes of each file open for writing, cut into chunks, with at most one partial chunk in memory per file; the version map (each path's newest version read); the `publish` command |
| Folder service (node host) | each view's pending changes (names and chunk lists, never bytes) with their bases; staging; boundaries; the report |
| Object gateway | a byte route for the folder service, on its own token |
| Folder core (SQL) | an upload holds the bytes its actor put under its own earlier intents (3a); the rest is live or in review (below) |

## Pending bytes

Written bytes go to the NAS as chunks before they are published, and are not part of the folder until then
(§2 "How pending bytes are handled"; founder decision 3: nothing on a node).

- **Chunks are cut in the machine.** The folder program keeps, for each file open for writing, the one chunk being
  written (at most 4 MiB, the version-2 manifest's chunk size). When a write moves past it, or the file is closed,
  the program hashes the chunk and sends it to the service, which streams it to the gateway. The gateway checks the
  hash, as for every put. The service holds only frame buffers; the node keeps no bytes.
- **A write inside a chunk already sent** (a database file, an editor saving in place): the program reads that chunk
  back (the service serves the view's own pending chunks), changes it in memory, and it becomes the file's partial
  chunk. Sequential writes, the common case, never read back.
- **Staging needs the manifest first.** An upload intent lists its manifest and chunks when it opens (C1D §3), but a
  big file's first chunks are sent long before its manifest is known. So each chunk sent while the file is still
  open goes under an intent of its own: a one-chunk manifest, opened, the chunk put, never sealed. That intent roots
  the chunk for 15 minutes; the service renews it while the file stays pending.
- **At close** the file's manifest is known. The service opens the file's own intent with it, puts the manifest and
  any chunk not yet sent, and seals it. A boundary then only commits. A file changed again before the boundary is
  staged again; the earlier intent lapses.
- **3a, the one core change.** At open, `present` lists the objects the actor may already read. A chunk the same
  actor put under its own earlier intent is not readable yet (no path names it), so today it would be put a second
  time. 3a marks such an object `held` as well: the catalog has it, and an unexpired intent of the same actor (kind
  and scope) in the same environment has it `put`. That is C1D §3's possession rule ("bytes it put under its own
  intent; the gateway checked their hash"), applied across intents. It takes the same `KEY SHARE` in hash order and
  the same GC mark check as today's `present`. No new lock.
- **Small files** (most) are one chunk: sent and sealed at close, in one intent.

Media type: a path that has a version keeps its media type; a new path takes it from its extension (a fixed table
in the service; the turn tools' rule, `.md` as `text/markdown`, is its first line), else `application/octet-stream`.
The executable bit is `chmod +x`. A structured file (`agent.md`, `group.md`, a routine file, `sections.md`, …) is
read back by hash and parsed at the boundary, as core §3 "Before the transaction" says.

## Pending changes and base versions

The service keeps, per view and in memory only, the view's pending changes on top of the live tree it already
holds: created, changed and deleted paths, renames, the executable bit, and each pending file's chunk list. Listings,
attributes and reads served to that view include them, so a program sees its own work at once. Other views see only
what is published.

**Base versions** (§2 "The base version of a path": the newest version the writer has seen). The folder program keeps
the mount's version map: for each path whose content it read, the newest version it read. Every read names its
version, so the map is exact. The program sends a path's base with each change it asks for, and the service uses it.
A save's base (a file opened for writing, its bit set, or a file renamed over it) is:
- a path the view read: the newest version it read, even if the feed has moved on since. An editor that read v1,
  while another machine published v2, saves with base v1, by writing the file in place or by renaming a temporary
  file over it, and gets a conflict, not a silent overwrite of v2;
- a path the view never read: the version the view showed when the save began. A blind `echo > f` therefore never
  overwrites a version the view did not see;
- a path the view showed as absent: no base, so its write must find it absent.

A move's or removal's base is the version the name showed when it was made (what `mv` or `rm` saw), and a moved or
removed folder records the view's position in the feed (`asOfSeq`) then. The feed keeps moving underneath: a pending
path keeps showing the view's own version, and the commit decides (a removed file another machine changes shows
again: "A boundary" below). After a save the map holds the version the save made.

**The map lives as long as the programs it protects.** An editor's buffer outlives a restart of the folder service
or of the folder program, so the map must too; otherwise a save after the restart would take the newest version as
its base and overwrite it. So the program keeps the map in memory and writes each new entry through to a file under
`/run/qorpera-folder/<mount>/` (a memory file system, root's only), and a program started again for the same mount
reads it back. It holds paths and version ids, never content, at most one entry per path the mount read, and goes when
the machine restarts, together with every process whose buffer it protected. A restart of the service loses the
pending changes (below), never the map.

The map is not authority. A writer that forges a base can only claim to have seen the live version, which it could
have read anyway; the core still checks every unit.

This replaces §2's "saved with each command's read record": step 3 has no commands.

## A boundary

A boundary publishes the view's pending changes as one change set.

**When.** In step 3: when the machine asks (`qorpera-folder publish <mount>`), for a mount configured with a quiet
period about two seconds after the last change (the desktop rule of §2), and before a change that needs what is
pending published first (below). Steps 4–6 add theirs: command end and output reads, and per-desktop quiet periods.

**What is left out** (§2 "Never published"):
- a file still open for writing by any process; it waits for a later boundary;
- lock, swap, backup and trash names (`.~lock.*#`, `~$*`, `*.swp`, `*.swo`, `.#*`, `*~`, `.Trash-*`): they stay
  pending, visible only in this view, and go when the view closes. A published path cannot be moved there (`EXDEV`;
  a file manager then offers to delete instead);
- a path created and removed between two boundaries.

**Units** (§2 "Units"), from the net change per path against its base:
- a file created or changed: `write` (with `expectedVersion` when it had a base);
- a rename or move, of a file or a folder: `move`; a temporary file renamed over its target is a `write` of the
  target;
- a new folder with everything created inside it: one `new_folder`;
- a deleted folder with everything inside it: one `delete` with `asOfSeq`; a deleted file: `delete`;
- `mkdir` of an empty folder: `mkdir`.

**Nothing the view holds is lost.** The core applies each unit whole or not at all, and the units of one change set
independently: one may save while another fails. And a unit's `expectedVersion` must be known before its change set,
while a move gives what it moves new versions. So the view only lets pending changes build up that can be published
together that way: every unit names a live path as it is, no unit needs a version another unit makes, and no unit's
failure can lose another's work. The units are ordered so a path is freed before it is filled, and a new folder made
before what goes in it. Then:
- **a conflict** keeps this view's version on the receipt (P17's conflict copies, below), and the path shows the
  live version;
- **refused, denied, or not applied** (its folder was not made, the save did not get through) for a unit carrying new
  bytes: the change stays pending in this view, the report says why, and the next boundary tries it again. An agent
  fixes what was refused by changing it again (a structured file that does not parse), or by copying its bytes to a
  path it may write (a folder it may not write: a kept change cannot be moved, since that would publish it first and
  it is still refused, so the move fails with `EBUSY`). A kept change nobody fixes is reported at every boundary, and
  goes when the view closes;
- a unit that only moves or removes, and fails, loses nothing: what it would have moved or removed is still live,
  and the view shows it again.
- **A removal never takes a version the machine did not see.** A removal of a file names the version the name showed;
  if another machine's change reaches the feed before the boundary, the removal is dropped and the file shows again.
  A removed or moved folder names the view's position (`asOfSeq`), and the core refuses it if anything in it changed
  since.

**Changes that publish what is pending first.** A change that could not be published together with what is pending
first publishes what is pending (a boundary, as when the machine asks), then is made on the live folder. These are:
- any change inside a folder this view moved (the move publishes first, then the change lands at the new path);
- moving or removing a folder with changes inside it, or one something was moved out of;
- reusing a path a moved or removed folder left (`rm -rf D; mkdir D`);
- changing a file this view moved, or moving a file this view changed;
- the move that would close a ring of moves taking each other's places (a swap, `mv a t; mv b a; mv t b`).
If what blocks it is still pending after that boundary (a file open for writing inside the folder being moved), the
change fails with `EBUSY`. The machine sees the change take longer; nothing else differs.

**Commit.** As the view's actor, with operation key `folder-view:<viewId>:<boundary id>`, where the boundary id is
random. The service keeps the exact units until the boundary has an answer, so a commit asked again after a lost
reply is the same change set under the same key, and the core replays it (the core refuses a key used for different
units, 22023). A boundary whose answer never came is asked again, unchanged, before the next one. If the service dies
during a commit, it has landed or not; the mount shows the live folder after the program reconnects either way.

**Outcomes and the report.** After the boundary the view shows the live folder, except the changes kept pending
(above), and the report lists every changed path: `saved`; `conflict`, with the receipt that keeps this view's
version; `refused` or `denied`, with the core's reason (no write authority, a seeded path, a structured file that does
not parse); `not applied`, with why (still open, a folder it needed was not made, the save did not get through); and
whether the change is kept pending. The reply to `publish` carries it, and the program prints it. A quiet-period
report is logged in the machine's journal until step 4 routes it to the desktop.

## Errors at once

As §2 "Errors that happen at once", decided in the program or the service before anything is sent:
- names the folder forbids (`EINVAL`), the adapter-only prefixes, symlinks, hard links, devices, FIFOs and sockets
  (`EPERM`), a file over 256 MiB, the version-2 manifest's limit (`EFBIG`);
- deleting or moving a seeded path, a lone `agent.md` or `group.md`, or an agent's or group's folder out of place
  (`EPERM`);
- `rename` with `RENAME_EXCHANGE` (`EINVAL`); a name that differs only in case from a sibling (`EEXIST`).

What needs the core is decided at the boundary. A path the view may read but not write is refused there and
reported, instead of failing at open with `EACCES` as §2 says. Proposal P9 below would move that to open.

## Protocol v2

The hello's answer says whether the view may write (`readOnly`). New requests on the `io` connection, each answered
with a small JSON reply or `e`. Every change names the base of each existing path it touches (`base`: for a save,
the version the mount last read of it, from its version map, left out for a path it never read; for a move or a
removal, the version the name showed):

| Type | Request | Reply |
| --- | --- | --- |
| `O` | open for writing `{path, base?, create, exclusive, truncate}` | `{handle, size, version}` |
| `K` | one part of a chunk: a header `{handle, index, sha256, bytes, offset}` and up to 1 MiB of its bytes | `{}`; after the last part, once the gateway has the chunk |
| `G` | part of a chunk the open file has `{handle, index, offset, length}` (at most 1 MiB) | its bytes |
| `C` | close `{handle, size}` | `{version}` once staged |
| `M`, `U`, `D` | mkdir, unlink, rmdir `{path, base?}` | `{}` |
| `N` | rename `{from, fromBase?, to, toBase?, noReplace}` | `{}` |
| `X` | the executable bit `{path, base?, executable}` | `{version}` |
| `P` | publish | the report |

As built (3c-2): a truncate of a file not open is an `O`, the chunk that ends it when the cut is inside a chunk, and a
`C`, so there is no `T`; a cut on the grid, or to nothing, sends no chunk, and the close cuts the file's chunks (from its
origin's when none of it was sent). A
chunk is changed by its index on the 4 MiB grid, which every version-2 manifest's chunks are on; a file laid out
otherwise is changed whole. A write handle belongs to the view, not to the connection that opened it, since the
program pools its connections. The version map holds the `version` of a close or the bit after a save; once that save
is published, the service reads a base or a read naming it as the version the save's change set gave the path (a
write's from the core's answer, a new folder's files' from that change set on the feed). A conflict's bytes leave the view only once the receipt lists every file of the
unit (`qorpera_folder_conflict_copies_of`, migration `20260930101000`): the commit's answer does not say what P17 kept.
An answered boundary settles only once the view's feed has its change set; until then the view takes no change (BUSY).
The intents that hold pending bytes are renewed while the bytes are needed and replaced if they lapse. The wire shapes
are in [RUNTIME-FOLDER-SERVICE.md](RUNTIME-FOLDER-SERVICE.md) ("Protocol 2").

Frames stay at most 2 MiB, so a 4 MiB chunk is four frames. The service still handles one request at a time per
connection, with the socket paused, so a machine can never make it buffer more than one frame of its bytes.

## The gateway's route for the folder service

Today's folder byte route (`/v1/folder-objects/`) takes a run's binding on the native token, with the run's lease in
`x-qorpera-identity` (G2-6a, `RUNTIME-NATIVE-HOST-KEY.md`). The folder service gets
a route of its own, `/v1/folder-service-objects/<environmentId>/<sha256>`, on a token only the folder service holds,
naming the view's actor in a header (`member`, `platform`, and later `view`). The gateway passes that actor to the
same SQL checks (`qorpera_folder_authorize_object_upload` and `_confirm_object`) and stores through
`uploadWithAuthority` as today. The folder service already holds the database's service credential, so the route
trusts it with no more than it has; the separate token keeps the native credential (runs, the office service) away
from it, which fits the coordinator's planned narrowing of the office service's native token.

Only node 1 runs an object gateway today. Node 2's folder service reaches it over the nodes' private link until S3
adds one per node, as runs on node 2 already do.

## Slices

Each is its own PR with an exact-head review, in this order; 3b and 3d can be built side by side.

**Before any mount writes, and before the conflict proof:** P17, a conflict's copy kept on its receipt with its GC
root (#783), and the erasure of those copies (#798) are merged and live. Without them a losing version would live
only in an upload intent and go when the intent lapses. The read path (#647, #656) is merged first, as 3c and 3d
extend it.

| Slice | What | Tests |
| --- | --- | --- |
| 3a | SQL: an upload holds its actor's own puts (migration `20260930083000`, test 931) | a chunk put under one intent is `present` in the same actor's next intent and not in another actor's; the whole file then seals and commits; an expired intent does not count; a marked object still refuses |
| 3b | Gateway: the folder service's byte route and token | put and refusal paths as `folder-objects.ts`'s tests; the native token is refused there, and the folder service's token on the native routes |
| 3c | Folder service: protocol v2, pending changes, base versions, staging, boundaries, the report (built as 3c-1, the pending changes and the boundary plan, #861; 3c-2, the protocol, staging and boundaries, #867; 3c-3, the hosted-db run, `scripts/test-folder-core-acceptance.mjs`'s F3-3c lines, #876) | the service's tests with a stand-in core that commits (conflicts, unseen changes, refusals, replays) and a stand-in gateway: a stale save (v1 read, v2 published, then saved in place and by renaming a temporary file over it) is a conflict, also when the service restarted between the read and the save; a lost reply replays under the same key; each change that must publish first does, and every boundary, applied to a model of the core's rules (folded keys included), ends as the view showed it; with each unit failing in turn no byte the view held is lost (it is live, kept as a conflict copy, or still pending); the hosted-db script runs the real commit on boundaries the service builds |
| 3d | Folder program: write operations, chunks, read-back, `publish` | FUSE tests on the test machine (a file written across chunks, a write inside a sent chunk, rename over a file, `rm -rf`, an open file left out, lock names; the version map kept across a restart of the program and of the service); the end-to-end test against the service: a stale save after a service restart, in place and by rename, is a conflict |
| 3e | Live proof (coordinator runs it): read-write operator mounts in a machine on each node, one test company | below |

**Live proof (3e)**, from the design's §10 "Ordinary work" and "Conflict":
- `sed -i` on a document, `mv reports/2026 archive/`, `mkdir -p` for a new folder, and a Python script that writes 200
  CSV files each land as one change set, and the web app's history shows them;
- the same file edited on both machines: one save, one conflict with its copy on the receipt;
- the other machine sees each save within about a second;
- numbers: the time to publish the 200 files, and a 200 MiB file's throughput (step 0 measured 12 small files a second
  to the NAS one at a time and 67 with eight at once, so staging runs eight to sixteen at once);
- `git status` and `git commit` in a repository in the mount, LibreOffice saving a document, and SQLite writing a
  database (in-place writes), as step 0 measured reads.

§2's build order puts a separate write spike first. Step 0 already measured the NAS's write rates, and 3c and 3d are
the code a spike would have to write anyway, so this plan has none: 3e is the spike, on the real program, and its
numbers decide whether step 4 needs more (packing small files, batching intents).

**Restore in the web app** (§9 step 3) is a write of an old version's file reference through the member commit route.
The core already lets an actor reference bytes of an old version it may read (C1D §7), so it needs no core change.
It belongs with the web file page and history (P27, the Interfaces session).

## Proposals and questions

- **P9.** Listings carry whether the actor may write each entry, so a read-only path fails at open (`EACCES`, §2)
  rather than at the boundary. Core work (F1's), not needed for step 3.
- **P10.** Batch staging: one call that opens the intents of many small files. Only if 3e's numbers ask for it.
- **Q1 (coordinator).** Step 3's mounts are operator-configured, as step 1's. Which test company, which machines, and
  whether a member or the platform is the actor.
- **Q2 (folder core owners).** 3a widens possession across intents of the same actor. Confirm this is the reading of
  C1D §3 you want, or say if a seal-time re-check is preferred.
