# The folder service and the folder program (F3 step 1: the read path)

Status: draft. Built ahead of the storage core so it can be reviewed and tested; it merges only after F1's C1–C3
are live, and it goes live only with the coordinator's rollout below. Design and decisions:
[RUNTIME-COMPANY-FOLDER.md, "Decided on 28 September 2026"](RUNTIME-COMPANY-FOLDER.md#decided-on-28-september-2026).
Install reference: [deploy/folder-service/README.md](../folder-service/README.md).

Step 1 shows one folder-v2 company, read-only, on the execution host, outside any box. Nothing an agent runs can
see it yet; step 2 (the run box) is the first user.

## The parts

| Part | Source | Runs | Holds |
| --- | --- | --- | --- |
| Folder program, `mount` | `crates/qorpera-folder` (Rust, `fuser` 0.18) | inside a machine, root | the view's id and pass; listings and attributes in memory; the kernel's page cache |
| Folder program, `bridge` | the same binary | node host, `qorpera-folder-bridge` (+ LXD's socket group) | nothing |
| Folder service | `packages/object-gateway/src/folder-service` (Node) | node host, `qorpera-objects` (the gateway's account, by a drop-in) | the service credential; each view's tree, chunks and manifests in memory |

The bridge exists because Node has no `AF_VSOCK`. It listens on vsock port 5250 and takes the peer's CID from the
kernel (LXD assigns it; a machine cannot choose it). For each connection, before any pass is checked, it asks LXD on
its local socket which running machine has that CID now, so asking stays cheap: a CID confirmed in the last two
seconds is answered from memory, a known one is confirmed with one single-instance request (one at a time per CID),
and otherwise the node's instances are listed, one listing at a time for the whole bridge and at most one a second.
A machine may get another CID when it starts again, so nothing older than two seconds is trusted; within those two
seconds a stopped machine's CID may still be named, and the view's pass is still required. The bridge sends what it
found as the first frame on the service's Unix socket, then passes bytes through untouched.
LXD's socket group is root-equivalent; the bridge holds it and reads nothing a machine sends, while the service,
which parses machine input, holds the database credential and never talks to LXD. Only the bridge's account can open
the service's socket (systemd socket, 0660, group `qorpera-folder-bridge`).

Nothing is written anywhere. A restart of either side refetches. A node's crash loses nothing that was saved (step
1 saves nothing).

## Protocol v1

A frame is a u32 big-endian length (of the type byte plus payload), one type byte, the payload; at most 2 MiB of
payload. Control messages are JSON; a read reply is the bytes. Rust: `crates/qorpera-folder/src/{frame,proto}.rs`;
TypeScript: `packages/object-gateway/src/folder-service/protocol.ts`.

| Type | Direction | Payload |
| --- | --- | --- |
| `B` | bridge → service, first and only once | `{cid, lookup: "found" \| "none" \| "unavailable", machine?: {project, name, physicalId}}` |
| `H` | machine → service, first from the machine | `{protocol: 1, environmentId, viewId, pass, role: "io" or "feed"}` |
| `h` | service → machine | `{protocol, viewId, asOfSeq, readOnly: true}` |
| `L` / `l` | io | `{path, after?}` / `{entries: [{name, kind, size, mtimeMs, executable, version}], next}` (`next` null on the last page), 1,000 per page, names in UTF-8 byte order; a name over 255 bytes is never listed |
| `R` / `d` | io | `{path, version, offset, length ≤ 1 MiB}` / the bytes |
| `c` | feed, service → machine | `{seq, resync, paths}`; no paths is a heartbeat (every 15 s) |
| `a` | feed, machine → service | `{seq}` |
| `e` | service → machine | `{code, message}` |

**Protocol 2 (writes, F3 step 3: `RUNTIME-FOLDER-WRITES.md`).** A hello may say `protocol: 2`; the answer echoes it and
says `readOnly: false` when the view takes writes (a writable operator mount). That is the view's, on either role: the
folder program learns it from its feed's hello and mounts read-write; writes are taken on `io` connections only (a
feed takes acknowledgements alone). A machine on protocol 1 reads only. On a writing connection frames may carry up to 2 MiB, and these requests are answered with `k` (`{}`, or
`{version}` for a close and the executable bit), `o`, `d` or `p`:

| Type | Request | Answer |
| --- | --- | --- |
| `O` | open for writing `{path, base?, create, exclusive, truncate}` | `o` `{handle, size, version}` |
| `K` | one part of a chunk: `[u32 header length][{handle, index, sha256, bytes, offset}][≤ 1 MiB]`, in order from offset 0 | `k` once stored (the last part) |
| `G` | `{handle, index, offset, length ≤ 1 MiB}`: part of a pending chunk back | `d` the bytes |
| `C` | close `{handle, size}`: the chunks must tile `size` on the 4 MiB grid; a file whose bytes are still its origin's is cut to `size` from the origin's chunks | `k` `{version}` |
| `M` | mkdir `{path}` | `k` |
| `U`, `D` | unlink, rmdir `{path, base?}` | `k` |
| `N` | rename `{from, fromBase?, to, toBase?, noReplace}` | `k` |
| `X` | the executable bit `{path, base?, executable}` | `k` `{version}` |
| `P` | publish `{final?}`: `final` only from a shell command's view, its last boundary (step 4b) | `p` the report `{commitId, seq, paths: [{path, outcome, reason?, receipt?, kept?}], closed?, refused?}`; `closed` when a final closed the view; `refused` (`denied`, `stopped` or `invalid`) when the core refused the change set whole, with `commitId` and `seq` null |

A truncate of a file not open is an open, the chunk that ends it when the cut is inside a chunk, and a close. A cut on
the 4 MiB grid, or to nothing, sends no chunk: the close cuts the file's chunks, from its origin's when none of it was
sent. A file whose manifest is not on the 4 MiB grid is changed whole (open it with truncate), not chunk by chunk. A write handle belongs to the view, not to
the connection that opened it (the folder program pools its connections); a file still open when the view's last
connection ends is abandoned, and what it held at its last close stays pending.

A save's base is the version the machine's version map holds: the newest it read of the path, or the version its own
save made (the `version` of `C` or `X`). Once that save is published, the service reads such a base as the version
the save's change set gave the path, so the machine's next save is based on its own published save and not on a
pending id the core never knew; a read naming it reads that version too, so a file held open since the save goes on
reading the same bytes. The same goes for a file this view moved: until the move is published its new path shows the
version it had before, which the machine may read and take as its base; once published, the service reads that
version as the one the move gave the file (the change set's `move_in` names both). A base naming any other version is
passed on as it is.

Error codes and what a program on the machine sees: `NOT_FOUND` ENOENT, `NOT_A_FOLDER` ENOTDIR, `NOT_A_FILE` EISDIR,
`STALE` ESTALE, `DENIED` EACCES, `BAD_REQUEST` EINVAL, `UNAVAILABLE` EIO; for writes `EXISTS` EEXIST, `NOT_EMPTY`
ENOTEMPTY, `NOT_PERMITTED` EPERM, `TOO_LARGE` EFBIG, `READ_ONLY` EROFS, `NOT_HERE` EXDEV and `BUSY` EBUSY.
`VIEW_CLOSED` and `VIEW_REFUSED` unmount the folder; the program exits 3 and its unit does not restart it.

`version` is the core's version id of the path (a uuid), opaque to the machine. A read names the version the machine
was shown, and the service serves exactly that version: the current one, or one of the last 16 replaced on the
feed, so a file opened before a change reads its own version to the end. Replaced versions go at the next full
listing if their path has left the view, and all at once on an access change; a read of one then is `STALE`.

On the machine, an inode is one version of a file. A newer version gets a new inode; the old one is detached (no
longer reachable by name, its attributes frozen) and stays readable by whoever opened it. So the kernel never mixes
pages of two versions in one file.

Memory per connection is bounded in the service: frames from a machine are at most 4 KiB until the hello is accepted
and 64 KiB after (2 MiB on a writing connection: a chunk part is up to 1 MiB, streamed on to the gateway, never
gathered), one request is handled at a time with the socket paused, the next waits until the machine has
read the last answer, and a feed connection whose machine leaves 4 MiB unread is ended (the machine reconnects and
drops its caches).

## Who may connect

Step 1 has no view rows: the core's view kinds need a leased run, an office screen or a coding session (C1b-3a).
Its mounts are named in the node's configuration instead (`mounts` in `config.json`): an id, the company's folder-v2
environment, the actor (`{kind: "member", userId}` or `{kind: "platform"}`), the machine (LXD project, name and
`volatile.uuid`) and the sha256 of the pass. A hello opens the view only if:

- the pass hashes to the configured value (compared in constant time);
- the environment matches;
- the bridge found the configured machine behind the connection: LXD says it is Running, has the peer's CID as its
  `volatile.vsock_id`, and has the configured `volatile.uuid` (a rebuilt or recreated instance has another).

Every refusal is the same `VIEW_REFUSED`. When LXD could not be asked or answered badly, the answer is `UNAVAILABLE`
instead, so the machine tries again rather than taking it as its view's end. A request connection refused after the
view was accepted ends the mount (it never stays mounted and failing). The pass is made inside the machine and never
leaves it; the node keeps only its hash.

On the execution host the mount is root's alone: no `allow_other`, under `/srv/qorpera-folder` (0700 root). The slot
units cannot open vsock at all (`RestrictAddressFamilies` without `AF_VSOCK`).

## Reading

On a view's first connection the service lists the actor's whole tree: `qorpera_folder_list` with `p_recursive`,
1,000 entries a page, keeping the first page's `asOfSeq`. It then follows `qorpera_folder_feed` from there, so
pages listed later are caught up harmlessly. Listings are served from that tree. A folder that holds readable paths
but that the actor may not list itself is shown anyway, so the paths are reachable.

Bytes come from the storage server's share (`<storageRoot>/<profileId>/<sha256>`, where `storageRoot`,
`/srv/qorpera/objects`, is the object gateway's store bound read-only into the service's own mount namespace), never
through the gateway's byte routes. The service reads them as the gateway's account, `qorpera-objects`, the same uid
on both nodes, in a process namespace of its own so it cannot reach the gateway's processes, and sees nothing of
`/srv/qorpera` but the store (README: "Reading the objects"). The service reads the manifest the core named, checks
its hash and that it matches the entry (v2; v1 for fixtures), then reads each chunk it needs, opened with
`O_NOFOLLOW`, checked for size and hash before it is used or kept. Chunks and manifests are kept in a
least-recently-used memory cache (1 GiB by default, at most 2 GiB within the unit's 3 GiB). Sixteen reads run at
once; each has a 30 s deadline counted from the request, waiting included. Committed objects are never collected
(C1d-2a roots every path version), so a reader holds no lease.

The company's storage profile is not in list, read or feed answers. The service learns it once per company and
process through `qorpera_folder_authorize_object_download` on the first file read (P2 below proposes a direct way).
That check refuses a company being deleted, but only at that first read: a company that enters deletion later is
still served until P1 lands.

The core client speaks HTTPS through `node:https`, never `fetch`: under the unit's `node --jitless` (kept for
`MemoryDenyWriteExecute`) `fetch` has no WebAssembly and fails. The service is bundled as CommonJS for the same
reason (the ESM facade of `node:http` loads its WebSocket export).

The folder program fetches a folder's listing when the kernel first asks for one of its names, keeps it, and
answers from it until the feed says the folder changed. Inode numbers are never reused while it runs. The kernel
keeps names and attributes for an hour and file pages across opens, and is told to drop exactly what changed. There
is no kernel listing cache (`FOPEN_CACHE_DIR`): the kernel keeps it while the folder's time is unchanged, and
adding a file does not change it.

A lookup answered from the program's memory just before a change can land in the kernel after the change's drop:
the kernel does not find a name it is still making, so without more it would keep the old name, or the old
version's inode, for the hour (found on node 2's kernel 7.0: 1 or 2 of the stress test's 300 races each run). So the
program remembers each name it answered with a cacheable entry, and the tree's change count it read it at, for 16
s. A change that names one answered before it drops that name again at 1, 2, 4 … ms after the change, 15 times. A
drop of a name the kernel no longer holds does nothing; one it holds again costs one more lookup (from memory), and a
folder's drop unhashes it, so a process working inside it reads `getcwd` as gone until it looks the folder up again:
harmless for step 1's read-only mounts, to be revisited (an expire-only drop) before commands run inside the folder
on machines. At most 65,536 answers are remembered: past that, those older than the window go first, then the older
half. A resync (a feed lost and back, or more than 5,000 changed paths) chases every name answered in the last 16 s,
which costs the chase thread up to a few seconds of CPU at that bound. fuser 0.18 cannot send the kernel's own fix
for this (`FUSE_NOTIFY_INC_EPOCH`, kernel 6.16), which would also drop every other name at each change.

## Staying current

- The service reads `qorpera_folder_clocks` (service_role select, C1f) every 500 ms for the companies with live
  views. When a clock moved, each view reads the feed from its position and pushes the changed paths.
- An access change on the feed (`{seq, kind: "authority"}`), or a position the core no longer serves, lists the
  view again; the difference is pushed. Until that listing is done the old tree serves: a path an access change
  took away goes when the new tree replaces it, a few seconds for tens of thousands of paths (P3 would narrow it to
  the changed resource). More than 5,000 changed paths, or a message too large for one frame, are sent as a resync.
- Grant expiry, member removal and agent archive are on no feed. Each view is listed again every 10 minutes (the
  due check runs when the work starts, so a long listing is not repeated), and a denial (42501) closes the view on
  every connection.
- The folder program treats 45 s without a frame as a dead link. While its feed is down it caches nothing and gives
  the kernel nothing to keep, so it never shows an older version than the node's. When the feed is back it drops
  everything once and carries on.

## Tests

`node scripts/run-on-node.mjs changed` runs the step `folder-program` on the node 2 test machine (it has no Rust):

- in `rust:1.95.0-slim-bookworm` (pinned by digest): the unit tests (frames, paths, the inode tree, the link, the
  bridge's LXD lookup against a stand-in LXD), and two FUSE tests that mount for real against a stand-in node
  (listing, reads, read-only refusals, the page cache, a file read on at its old version while a new reader sees
  only the new one, a change shown at once, a new file, a removal, a feed that breaks and comes back, a view closed,
  a view refused), and a third that races 300 lookups against removals and new versions and requires every one to
  show the change within a second;
- then the built program in `node:24.21.0-bookworm-slim` against this package's folder service with a stand-in core
  and share (`packages/object-gateway/test/folder-mount-e2e.test.ts`): a 3 MiB file across chunks, a member's edit
  shown in under a second, a folder taken away disappearing, SIGTERM unmounting.

The service's own tests (`packages/object-gateway/test/folder-service.test.ts`) cover the protocol checks, the tree,
the share reader (tampered chunks, links, mismatched manifests) and the service over its socket (refusals by pass,
machine and LXD, oversized frames before the hello, a second bridge frame, paging, replaced versions, access
changes, closing, a machine that does not read its answers, changes too large for one frame).

`scripts/test-folder-service-core-shapes.mjs` (in the hosted-db step) runs the real folder-core functions on the feed
test's history (636) and parses their answers with the service's parsers: listings (platform, member, paged), the
feed (from nothing and mid-change-set with a cursor) and a resync. The tree built from the feed alone, and the
listing caught up by the feed, both equal a fresh listing.

`scripts/package-folder-service.test.mjs` runs the packaged service and the core client's transport under `node
--jitless`.

Containers stand in for neither LXD nor vsock: the first live run on node 2 is the proof of those (step 0 measured
the link, 27 µs round trips).

## What step 1 needs from the core, and proposals

Uses, all live: `qorpera_folder_list` and `_feed` (C1a, C1f), `qorpera_folder_clocks` (C1f),
`qorpera_folder_authorize_object_download` (C1d-1a). Waits on: C1c's activation checks before a folder-v2 company
holds production data; C2–C4 for a member's edit of the proof company in the web app.

Proposed shapes (not built here; the core is F1's):

- **P1. A company being deleted is still listed for members and the platform.** `qorpera_folder_read_actor` refuses a
  deleting company only for runs. One guard at its top (55000 when a `qorpera_company_deletions` row exists for the
  environment's profile) closes it for list, read and feed. The download check already refuses everyone.
- **P2. `qorpera_folder_companies(p_environment_ids uuid[])`**: `{environmentId, profileId, lastSeq, paused,
  deleting}` per company, service_role only. One call per poll instead of the clock table plus a download check for
  the profile.
- **P3. Detail on authority events**: `{resourceId|grantId, revision}` per change (and the prefix for the platform),
  so a view drops only what a narrowing covers instead of listing everything again.
- **P4. Grant expiry**: the earliest expiry behind a listing, so the service lists again exactly then, not every 10
  minutes.
- **P5. Seeding a proof company**: the gateway's folder route accepts only run actors; the operator needs a platform
  route for a proof company's files.

For step 2 (the run box), recorded now so they are planned:

- **P6.** `qorpera_folder_view_open` for a `run_box` supersedes the run's open run box, so a folder-service restart
  can open it again (today the unique index refuses with 23505 and the old pass lived only in memory).
- **P7.** A run box view records its node (`node_id`), and `qorpera_runtime_node_drain_status` counts open views per
  node. For S3's drain read, the columns are `qorpera_folder_views.node_id` (text), `machine_id` (uuid),
  `unsaved_since` (timestamptz), with `state = 'open'` and `lease_until > now()` (20260928259230). Step 1 opens no
  view rows, so it gives the drain nothing to count; an in-place folder service update needs no drain.
- **P8.** The runtime releases a command's reads with the run actor (only run releases can be cited by a context
  view); a release over 10,000 reads is split, and a context output may need to cite several. On a company machine,
  step 4 replaces this: a command's reads are the folder program's, released with its view actor, and its output
  cites no read ([RUNTIME-FOLDER-COMPANY-MACHINES.md](RUNTIME-FOLDER-COMPANY-MACHINES.md), "Reads").

## Rollout (coordinator)

Changes: two new units and a socket on each node host; in the execution host, the folder program and its mount unit,
carried by the shared-execution package (step 2a), and `/srv/qorpera-folder` and `/etc/qorpera-folder` hidden from
both slot units. No runtime bundle, image, provider, SQL or LXD configuration change; the node inventory is
unaffected (no instance or device change). Safe for the running bundle. The coordinator's cut builds the folder
program in the pinned Rust image and passes it to the shared-execution packager (`--folder-program`).

1. Read-only prechecks, both nodes:
   - `ss -l --vsock` shows nothing on port 5250; `lsmod | grep vhost_vsock`.
   - As root, `findmnt --target <the store>` (the gateway's store as the host sees it, README) names
     `/srv/qorpera/canonical` from the storage server.
   - The coordinator's account change is done (README: "Reading the objects": the account, the gateway moved to it,
     its files chowned): as root, `stat -c '%U %a' <the store>/<a profile>/<an object>` shows `qorpera-objects 600`.
   - In the execution host: `ls -l /dev/fuse; grep fuse /proc/filesystems`.
   - `lxc config get qorpera-exec-node02 volatile.uuid --project qn25b2`.
2. Build and package on the node 2 test machine from the release commit (README); the build's record must equal the
   commit's `deploy/folder-service/folder-program-linux-x64.json`.
3. Node 2 host: install; write `config.json`, the key and the drop-in `read-objects.conf` (README: "Reading the
   objects"; without it the service runs as `qorpera-folder` and every read fails as unavailable); run the README's
   checks; enable the socket and the bridge. Node 1 host: the same, with an empty `mounts` list (node parity compares
   every `qorpera-*` unit).
4. Execution host on node 2: a full `rebuild-exec-host.sh` with the shared-execution package, as at any cut (drain the
   host, the current image, the orchestrator restarted as the script says); it installs the folder program and
   refuses an unpinned one before stopping anything. Then the view file and `systemctl start
   qorpera-folder-mount@proof`. Prove once, with the mount live and again with it hung (`kill -STOP` on the mount's
   process, so the kernel waits on it rather than failing fast), that a slot pair still starts:
   `InaccessiblePaths=/srv/qorpera-folder` over a FUSE submount must neither fail nor hang the start. Then `kill -CONT`.
5. Acceptance (the design's step 1 proof), as root in the execution host:
   - `find /srv/qorpera-folder/proof | wc -l` equals the proof company's path count, and
     `rg -l <word> /srv/qorpera-folder/proof` finds what the web app's search finds;
   - a member's edit in the web app shows in `cat` within about a second (waits on C2–C4);
   - a folder taken away from the mount's actor disappears within about a second;
   - a slot account gets `Permission denied` on `/srv/qorpera-folder`;
   - node 2 stays `ready`; the folder service's journal shows no integrity error.
6. Rollback: stop the mount unit (it unmounts), then disable the bridge, the socket and the service. Nothing else is
   kept.

## Step 2a: run box views and the package (draft, on top of step 1)

- **The shared-execution package carries the folder program** (pinned by `EXPECTED_FOLDER_PROGRAM_SHA256`, recorded in
  `deploy/folder-service/folder-program-linux-x64.json`) and `qorpera-folder-mount@.service`; both slot units hide
  `/srv/qorpera-folder` and `/etc/qorpera-folder`. A change to `crates/qorpera-folder` needs a new record (the
  scripts test fails until it is committed) built with `scripts/build-folder-program.mjs`, and the `folder-program`
  test step checks a fresh build gives the recorded bytes.
- **The folder service takes the core's run box views.** A hello whose view id is a uuid is a core view: its pass must
  have the core's shape (43 base64url characters), the calling machine must be one of this node's `runBoxHosts` (the
  execution host; from step 4a only for a view the core says is a run box, below), and the core checks the pass
  when the view is first listed and at every renewal (a wrong first pass closes it). The service renews the lease at
  once on the first listing, then every 40 s while a machine is connected (`qorpera_folder_view_renew`), and serves
  the view only until the lease the core confirmed: past it, during a database outage, every call is `UNAVAILABLE`
  until a renewal succeeds. A closed answer, or a refusal, closes the view on every connection and forgets its pass.
  Further connections must present the same pass and company folder; while a first hello is still being checked,
  another is asked to try again, and an unchecked view is replaced, so a wrong pass or company folder never locks out
  the right one. A core view no machine holds is dropped at once with its pass (its lease is not renewed while idle);
  a machine that comes back lists it again and renews at once. The run's end closes its run box in the core (and the
  next renewal tells the machines, within 40 s). What a machine already cached stays readable on it until the feed or
  the close says otherwise.
- `scripts/test-folder-service-core-shapes.mjs` also opens a run box view for a leased run on the views test's company
  (639) and checks its listing, feed replay, renewal, close, and that a closed view is refused.

## Server-side search (replaces step 2b's run box)

The founder's "Light threads" decision (2 October 2026): a chat turn has no shell. In a turn an agent lists, reads
and searches the company folder through server-side tools that act with the run's own view; commands run on machines
(the company machine, a coding machine, an agent machine; steps 4 to 6). Search runs here, on the node's folder
service, so the execution host stays small:

- **The run's view.** The native host opens it itself with the run actor (`qorpera_folder_run_view_open`, through
  G2's entry point, migration 20260929999970) and presents it like any core view, from the execution host, one of
  this node's `runBoxHosts`. It keeps the connection for the run, so the view's tree is listed once and kept current
  from the feed; the run's end closes the view.
- **Receipts.** For an agent's view the node's entries carry the core's read receipt `{resourceId, resourceRevision,
  grantId, grantRevision}`: from the core's listing, or, for a path the feed brought, the path's earlier receipt or
  the nearest folder's above it that has one. A new receipt (after an access change) counts as a change. A stale or
  missing receipt costs the core a per-path check at release, never a wrong record. Members and operator mounts get
  none.
- **`S` / `s` frames.** `{query, path, glob, namesOnly, caseSensitive, after}` answers `{hits: [{path, kind, line,
  text, version, offset}], searched, binary, unreadable, reads: [{path, kind, version, authority?}], next}`. Only a
  run's own view (a core view) searches; an operator mount's machine gets `BAD_REQUEST`.
  - **What it finds.** Literal text in the lines of text files (a NUL in a file's first 8 KiB makes it binary: passed
    over and counted), or with `namesOnly` in the names of files and folders. A hit names its version and the byte its
    line starts at (0 for a name), so a run that shows a page in part goes on from the first hit it left out. A line
    longer than 1 MiB is searched as it comes, a stretch at a time, keeping the query's length of each stretch's end,
    so a match across two stretches is found; it keeps one line number and gives one hit.
  - **Globs.** `glob` keeps to matching paths: `*` and `?` within a name, a whole `**` part for any number of folders
    (a `**` inside a name is a `*`; a trailing `**` also matches the folder itself, so `docs/**` keeps `docs`); a glob
    without '/' is matched against the name. Matching walks the name and the
    pattern with one place to go back to: at most their lengths multiplied, never exponential, whatever the glob.
  - **One page per call.** It walks the view in the order a machine lists it, straight from the cursor (never past
    what came before it), and answers when its hits fill about 6 KiB, when it has drawn on 4,000 paths or 1 MiB of them
    (so a page always fits one frame, however long its paths), or after about 2 s of work. It ends only once it has
    moved the search on (at least one entry, and inside a file only between lines), so no page repeats the last; a
    page that reaches a very long line finishes that line first, so it can run past 2 s by the time the line takes.
    About every 10 ms it gives the node's event loop a turn and checks the view is still served, so a page stops at the
    first turn after its view closes or its lease lapses (cutting the text around a hit in a stretch of a very long line
    can hold the loop longer, about 200 ms for 4 MiB). `next` is a path, and inside a file the byte and line to go on from, in the version it was
    searched at; a client never shows it (the run seals it). A page is never the search's end: there is no cap.
  - **Errors.** A path not in the view is `NOT_FOUND`; a run view the core ended is `VIEW_CLOSED` (the run opens
    another); an operator mount's view is `BAD_REQUEST`. A storage server that cannot be read now fails the page
    (`UNAVAILABLE`), and so does a share with no folder for the company's objects (an unmounted share shows an empty
    mountpoint), so a page never looks empty because the share is gone. A file whose bytes are missing from a share
    that is there, or fail their hash check, is passed over, counted in `unreadable`, logged and not read. A `path` that names a file may give an empty page; that only confirms what the
    model named.
- **What a page read.** `reads` names every folder whose names it walked, every file whose bytes it read (binary
  ones too), and every entry whose name is a hit, each with its receipt. A folder shown only because it holds readable
  paths (no version of its own) is never a name hit. A resumed page passes through the cursor's folders without
  reading them again: the page that gave the cursor drew on them. The run releases a page's reads with the run actor
  under the hash of the text it shows (`qorpera_folder_record_release`, P8), before the model sees it.
- **Memory.** A searching run holds its view's tree, about 670 bytes a path: 16 runs at once of a 100,000-path
  company take about 1 GiB of the service's memory beside its object cache.
- **The relay.** A native host is a Node program and has no vsock, so the execution host carries its connection.
  - `qorpera-folder-relay@N.socket` (`/run/qorpera-folder-relay/N.sock`, the slot's native host account only, 0600)
    runs `qorpera-folder relay`. It copies bytes both ways to the node's bridge (vsock 2:5250), reads none of them, and
    goes on past an accept that fails for the moment. A listening socket that can never accept again (EBADF, EINVAL,
    ENOTSOCK, EOPNOTSUPP) ends it with a failure, and systemd starts it again.
  - The relay runs as a dynamic user with no capabilities, private devices and IPC, and only `AF_UNIX` and `AF_VSOCK`.
  - While `QORPERA_SHARED_EXECUTION_FOLDER_SEARCH=on`, the shared execution service asks for the slot's relay socket
    before its native host and names it in the host's environment (`QORPERA_FOLDER_SEARCH_SOCKET`). The host connects
    at its first search. A relay that does not start costs that run its search, never the run.
  - **Switching it off:** set the variable `off` and restart the service, end the warm slots, then
    `systemctl stop 'qorpera-folder-relay@*.socket' 'qorpera-folder-relay@*.service'`.
  - **Before switch-on (rollout):** one hello through `/run/qorpera-folder-relay/0.sock`, as the slot's host account,
    must reach the node's folder service (socket activation, the dynamic user and the vsock connect on the real host).
- The `company_search` tool itself is the runtime's (its own PR).

## Step 4a: company machines' desktops

F3 step 4 puts the company folder on every company machine
([RUNTIME-FOLDER-COMPANY-MACHINES.md](RUNTIME-FOLDER-COMPANY-MACHINES.md)). In slice 4a the folder service serves a
computer desktop's view, which the core opens for an office screen (C1b-3a):

- **Which machine.** A core view's hello is also taken from a company machine: a machine in one of this node's
  `companyMachineProjects` (its office project; which ones is the plan's Q1) named `qorpera-office-<32 hex>`, as the
  node names a company machine after its allocation (`lxd-office-guest.ts`). The view's first renewal says its kind
  and machine allocation (#880), and from then on the service serves:
  - a run box only to a `runBoxHosts` machine, read-only;
  - a computer desktop only to the company machine named after its allocation, read-write;
  - any other kind (a coding session's: step 5) to no machine yet.
  A hello from any other machine is `VIEW_REFUSED`, like every refusal, also when it joins a view that is open. The
  core never changes a view's kind or machine; a renewal that says otherwise closes the view, losing what it had
  pending.
- **Writes.** A desktop's view writes as an operator mount with `write` does (RUNTIME-FOLDER-WRITES.md), acting as the
  view. It publishes 2 s after its last change (`DESKTOP_QUIET_MS`, the desktop rule of RUNTIME-COMPANY-FOLDER.md §2),
  when its machine asks, and when its last connection leaves: what is pending then is published under the lease it
  still has, and the view is dropped after, unless that publish has no answer or a refusal that may lift (then it is
  kept: Step 4c, "Kept"). A machine that comes back meanwhile joins it.
- **The seat in use.** Each renewal tells the core since when the view has had changes not published
  (`p_unsaved_since`, C1b-3 §9), or null. Unsaved means what a boundary publishes: a removal, or a new, moved or
  changed file or folder. A lock, swap, backup or trash name a program holds is never published and is none, nor is a
  file opened but not changed. The first change not published renews the lease at once, so the core counts the
  desktop's seat in use from then, not up to 40 s later. A boundary that leaves nothing unsaved clears it at the next
  renewal, and a view its machine lets go, if the core last heard it had unsaved changes, renews once with null before
  it is dropped, so the seat is free then, not when the lease ends.
- **Parked changes.** A unit the core parks for review (`waiting_for_review`, reason `parked`: P40, an agent's change
  that needs a member's) is a proposal now, and the agent's next run reviews it. The view lets it go and shows the
  live folder, as for a unit saved. Until step 4's report reaches the desktop, the service logs every outcome of a
  boundary no machine asked for that did not save.
- **Tests.** `packages/object-gateway/test/folder-desktop-views.test.ts`, with the stand-in core; the core shapes script
  checks a run box's renewal says `run_box` on no machine.

## Step 4b: shell commands

In slice 4b the core opens a view of its own for an offline shell command (`computer_shell_command`, migration
`20260930183000`; RUNTIME-COMPANY-FOLDER-C1B.md §8), and the folder service serves it:

- **Which machine.** Like a desktop's: only to the company machine named after the view's allocation, read-write.
- **Publishing.** Only when the machine asks, or before a change that needs what is pending published first: no quiet
  period. The command's last call sends `P` with `final: true`. The final publishes everything the view has pending as
  one change set, or an empty one when nothing is, and the core closes the view with it, whether it saved anything or
  not: the report says `closed`, and the view is closed on every connection. A path still waiting (a file open for
  writing) holds the whole final back, with nothing committed: each path stays pending, and the machine asks again. A
  final from any other view is `BAD_REQUEST`; one on a view that has closed otherwise is `VIEW_CLOSED` with why it
  closed.
- **No answer.** A final whose commit got no answer is asked again, final, under its key and as the actor it was asked
  as, before anything else; until then the report says each path's save did not get through yet. The core may have
  applied it, and so closed the view, and a renewal may then close the view here before the answer comes, while the
  final is still being asked or after. The view then stays, with that final, until it has an answer or the view has
  been idle as long as any other: the next `P` with `final: true`, on the same connection or on a new one with the
  view's pass, asks the final again, and since the core answers a replay on a closed view, given its pass, its answer
  is the report (`closed`). If the core refuses it instead, the final did not close the view: the view goes, and the
  machine hears `VIEW_CLOSED` with why it closed. Such a view does nothing else (`VIEW_CLOSED`, a `P` without `final`
  included; it takes a read log's `I` and keeps none of it: Step 4c, "A final asked again"), and a hello with another
  pass is `VIEW_REFUSED`.
- **Refused whole.** The core may refuse a change set whole, a final included: `denied` (42501: among others, a read
  of the command's that is no longer readable, or a change set other than the final once the command has ended),
  `stopped` (55000: the company is paused) or `invalid` (22023: among others, more than the core's 1000 units in one
  change set). The report then has `refused` with that reason, `commitId` and `seq` null, and each path `refused` and
  kept pending. The view stays open, so a final refused while the company is paused can be asked again once the pause
  lifts; but a final refused after a renewal closed the view meanwhile did not close it, and the machine hears
  `VIEW_CLOSED` with why it closed. A boundary is never split: a final carrying more than 1000 units is refused `invalid` every time, and, as
  after any final refused for good, the office service closes that view itself (slice 4d,
  RUNTIME-FOLDER-COMPANY-MACHINES.md).
- **The command's end.** Once the command's end is recorded (C1B §8), the core saves only the final. A change set it
  refuses whole stays pending, so the final carries it.
- **Kept for the final.** A command's view that its own machine has held is kept when its last connection leaves: its
  pending changes stay, nothing is published, and its lease is still renewed, until the final closes it or the core
  does, or a boundary of it is refused for good (then it is dropped: Step 4c, "Kept"). Its renewals always say nothing
  is unsaved (no seat waits on a command).
- **Tests.** `packages/object-gateway/test/folder-command-views.test.ts`, with the stand-in core, which saves only the
  final of a view whose command ended, closes the view with the final, and answers a replay on a closed view given its
  pass, as the core does. Among them: a final refused whole, empty or not; a final whose answers were all lost while
  a renewal closed the view, after its tries or between them, asked again on the same connection and on a new one; and
  a final refused once a renewal closed the view between its ask and its answer.

## Step 4c: read releases

In slice 4c-1 the folder service takes the reads a company machine logs on a core view, and releases them to the core
with the view as the actor before anything made from them is published (RUNTIME-FOLDER-COMPANY-MACHINES.md, "Reads"):

- **Protocol 3.** A machine that logs its reads says protocol 3 in its hello. A core view (a desktop's or a command's)
  takes writes only from it: on protocol 2 its hello says `readOnly`. An operator mount's view still writes from
  protocol 2. On a writing connection the machine sends `I` with consecutive entries of its log,
  `{log, reads: [{seq, path, version, authority?}], lost?}`: `log` is the mount's (new each time the mount is made),
  `version` the version the read showed (null for a folder's listing) and `authority` the receipt the service gave the
  path. The answer, `i`, says how far the view holds the log: every entry up to `taken`, and up to `released` the core
  has them. A batch that leaves a gap is not taken, and the machine sends it again from `taken`. A path is never empty,
  so the program logs no listing of the root (slice 4c-2): a company-wide view opens only when its actor reads the
  root resource (C1b-3 §2).
- **Reads before writes.** The service releases only the entries it holds, and a desktop's view publishes on its own
  quiet period. So a machine has a read's entry taken (an answer with `taken` at or past its `seq`) before it sends
  any change made after that read, on any of its connections, and before `P`: a change that arrived first could be
  published with the read not released.
- **Releases.** Each boundary (a quiet publish, a `P`, the last connection leaving) first releases the reads the core
  does not have yet, at most 10,000 in one release (`RELEASE_READS`, the core's bound), and publishes only once they are
  released (the log's rule 1). A read goes with its version only when that names bytes the core made that the view
  showed (a file the view saved and has not published goes with the live version under it, or none), and with no
  receipt when it was logged without one: the core then checks the path again. A release with no answer, or refused, is
  asked again first under the same id, and the core replays it. A member-held desktop view records no reads: the core
  refuses its release (22023), and its reads count as released. So do an operator mount's, which has no read set.
- **Refused.** A boundary whose release the core refuses publishes nothing, and its report has `refused` with the
  release's reason: `unreadable` (42501, "A released read is no longer readable": a read's access narrowed before it was
  released), `run_ended` (42501, "Run is unavailable": the run the view acts for has ended, or its deadline passed while
  its job is still leased), `denied` (any other 42501), `stopped` (55000, the pause) or `invalid`. A release with no
  answer after three tries leaves the boundary with none: each path's save did not get through yet. A change set refused
  because a read released earlier is no longer readable ("A read is no longer readable") is `denied`, as before.
- **A log that cannot be shown complete.** A batch with `lost: true` says the machine cannot show its log complete (the
  log's rule 4). From then on every boundary of the view is refused `unproven`, a boundary with no answer asked again
  included; the office service's way out (slice 4d) stops the mount's users and closes the view. The service keeps
  this with the view, in memory: a view dropped or closed, or a folder service restarted, forgets it. So after every
  new hello on the mount the machine's first `I`, before any change, says `lost: true` again, until the mount is made
  again.
- **Kept.** A desktop's view whose last connection leaves while its last boundary had no answer, or a refusal that may
  lift (the pause, the run check), is kept like a command's: its pending changes and unreleased reads stay and its lease
  is renewed, and a later publish from its machine publishes it; nothing else does (its quiet period ends with its last
  connection). Once a boundary hears another answer (a save, or a refusal for good) it is dropped like any other view
  no machine holds. A command's view is kept for its final unless its last boundary was refused for good. A boundary
  still running when the last connection leaves, or one that runs after it (a change that landed then), decides again
  when it ends: the view stays kept, or is let go. Until then the view is not forgotten as idle, however long the
  boundary takes. A desktop's change set refused by the pause or the run check stays
  pending, as a command's does, for a later boundary to carry.
- **A final asked again.** A command's view that closed while its final had no answer (Step 4b, "No answer") takes `I`
  and keeps none of it, a `lost` included: the core answers that view nothing but the final's replay, which publishes
  nothing new, so nothing can come of those reads. The answer says every entry taken and released. So a dead
  program's `qorpera-folder publish --state-dir --final` (slice 4c-2) hands its log over first, as for any view, then
  asks the final again.
- **Twice.** A view keeps its reads in memory only: after it connects again a machine sends every read it has not heard
  released. A view dropped, or a folder service restarted, may so have some released twice, which files nothing new. A
  view that goes takes its unreleased reads with it: they reached no save of it.
- **Tests.** `packages/object-gateway/test/folder-read-releases.test.ts`, with the stand-in core, which releases as the
  core does and refuses as it does; and the acceptance script's F3-4c lines on the hosted database: a desktop view's
  read released through the service before its save; after a narrowing of a read's path, every later save of the view
  refused (two in a row); and a read not yet released when a narrowing comes, every later boundary refused
  `unreadable`.

## Not here

Moves to a newer view in place (`switch`), a closed desktop view kept for its minute, and a kept view refused because
a newer one replaced it (slice 4c-3); the folder program's read log, its `--state-dir` and `qorpera-folder publish`
(slice 4c-2); the office service's side of a command's view (opening it, mounting it for the command, and the final
boundary at the command's end: slice 4d); coding machines and test machines (each with its own mount). Each is a later
step.
