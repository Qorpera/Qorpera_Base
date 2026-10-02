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
| Folder service | `packages/object-gateway/src/folder-service` (Node) | node host, `qorpera-folder` | the service credential; each view's tree, chunks and manifests in memory |

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
| `L` / `l` | io | `{path, after?}` / `{entries: [{name, kind, size, mtimeMs, executable, version, authority?}], next}` (`next` null on the last page), 1,000 per page, names in UTF-8 byte order; a name over 255 bytes is never listed. `authority` (step 2b-2) is the core's read receipt `{resourceId, resourceRevision, grantId, grantRevision}`, only in an agent's view (a run box's) |
| `R` / `d` | io | `{path, version, offset, length ≤ 1 MiB}` / the bytes |
| `c` | feed, service → machine | `{seq, resync, paths}`; no paths is a heartbeat (every 15 s) |
| `a` | feed, machine → service | `{seq}` |
| `e` | service → machine | `{code, message}` |

Error codes and what a program on the machine sees: `NOT_FOUND` ENOENT, `NOT_A_FOLDER` ENOTDIR, `NOT_A_FILE` EISDIR,
`STALE` ESTALE, `DENIED` EACCES, `BAD_REQUEST` EINVAL, `UNAVAILABLE` EIO. `VIEW_CLOSED` and `VIEW_REFUSED` unmount
the folder; the program exits 3 and its unit does not restart it.

`version` is the core's version id of the path (a uuid), opaque to the machine. A read names the version the machine
was shown, and the service serves exactly that version: the current one, or one of the last 16 replaced on the
feed, so a file opened before a change reads its own version to the end. Replaced versions go at the next full
listing if their path has left the view, and all at once on an access change; a read of one then is `STALE`.

On the machine, an inode is one version of a file. A newer version gets a new inode; the old one is detached (no
longer reachable by name, its attributes frozen) and stays readable by whoever opened it. So the kernel never mixes
pages of two versions in one file.

Memory per connection is bounded in the service: frames from a machine are at most 4 KiB until the hello is accepted
and 64 KiB after, one request is handled at a time with the socket paused, the next waits until the machine has
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

Bytes come from the storage server's share (`/srv/qorpera/canonical/<profileId>/<sha256>`), never through the
gateway's byte routes. The service reads the manifest the core named, checks its hash and that it matches the entry
(v2; v1 for fixtures), then reads each chunk it needs, opened with `O_NOFOLLOW`, checked for size and hash before it
is used or kept. Chunks and manifests are kept in a least-recently-used memory cache (1 GiB by default, at most 2 GiB
within the unit's 3 GiB). Sixteen reads run at once; each has a 30 s deadline counted from the request, waiting
included. Committed objects are never collected (C1d-2a roots every path version), so a reader holds no lease.

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
  a view refused);
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
  view); a release over 10,000 reads is split, and a context output may need to cite several.
- **P9.** `qorpera_folder_record_release` takes a read without a receipt and checks its path, instead of refusing the
  release (22023); today the run box's tools send a nil-uuid stand-in for such a read (step 2b-2).

## Rollout (coordinator)

Changes: two new units and a socket on each node host; in the execution host, the folder program and its mount unit,
carried by the shared-execution package (step 2a), and `/srv/qorpera-folder` and `/etc/qorpera-folder` hidden from
both slot units. No runtime bundle, image, provider, SQL or LXD configuration change; the node inventory is
unaffected (no instance or device change). Safe for the running bundle. The coordinator's cut builds the folder
program in the pinned Rust image and passes it to the shared-execution packager (`--folder-program`).

1. Read-only prechecks, both nodes:
   - `ss -l --vsock` shows nothing on port 5250; `lsmod | grep vhost_vsock`.
   - `stat -c '%U %a' /srv/qorpera/canonical/<a profile>/<an object>` and which account the gateway writes as; decide
     the folder service's read access (README).
   - In the execution host: `ls -l /dev/fuse; grep fuse /proc/filesystems`.
   - `lxc config get qorpera-exec-node02 volatile.uuid --project qn25b2`.
2. Build and package on the node 2 test machine from the release commit (README); the build's record must equal the
   commit's `deploy/folder-service/folder-program-linux-x64.json`.
3. Node 2 host: install, write `config.json` and the key, enable the socket and the bridge. Node 1 host: the same,
   with an empty `mounts` list (node parity compares every `qorpera-*` unit).
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
  execution host; any view kind from it is accepted until P7 adds the view's own node), and the core checks the pass
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

## Step 2b: the run box (drafts, on top of step 2a)

Three stacked drafts. Founder choices (2026-10-02): the box's tools come with the runner image; the execution host
grows so each slot gets a box.

**2b-1, the box (this draft).** Every run on a folder-v2 company gets a box of its own on its slot of the shared
execution host (`deploy/shared-execution/README.md`, "Run boxes"):

- The root shared-execution service opens the run's view itself, with the run actor, once the runner holds its job
  (`view_open` refuses before), writes the view file on the slot's tmpfs and starts `qorpera-shared-box@N`. That pulls
  in the box's folder unit, which mounts the view with `allow_other` through the node's folder bridge, and the box's
  socket, which only the slot's native host account can open. At the run's end the box goes first (also when the
  native host parks), then the service removes the view's file and closes the view after its lock (best effort).
- The box runs the box host (`packages/runner-orchestrator/src/run-box-host.ts`) as a third account per slot:
  `/company` read-only, home and `/tmp` in memory, no network, no capability, its own `/dev/shm`, nothing of the
  host's state, run material or credentials. The box host runs commands under bash (optionally on a terminal, for
  input), answers with their output since the last answer (head and tail when long, all of it kept in the box's
  home) and lets them run on after an answer; they end with the run. Its protocol is `@qorpera/contracts`
  `run-box.ts`, and the native host trusts none of its answers.
- Proof: `scripts/test-run-box-systemd.mjs` installs the package with its real installer in a disposable systemd
  container and runs one box against this repository's folder service (core in memory) with the real folder
  program, from the native host's account: reads, no writes, nothing secret visible, no network, no capability, a
  terminal command, long output, a member's edit showing, every command ending at the run's end, a fresh box per run,
  and no box for a refused view.
- Inert until `QORPERA_SHARED_EXECUTION_RUN_BOX=on`, and without real folder-v2 runs (C3, C4, C1c-3d–3m) nothing opens.

**2b-2, the read log (this draft, on top of 2b-1).** The box's folder program logs every version the box opens or lists
(the program sees every open, cached pages or not, and every listing), with the receipt the node listed it with, and
gives the log to the slot's native host on a second socket, `/run/qorpera-shared-box/N.reads`, which only that account
can open:
- `{"t":"take","after":S,"max":N}` answers `{"t":"reads","log":L,"reads":[{seq, path, kind, version, authority?}],
  "more"}`, the oldest reads numbered after S. Taking removes nothing. A host takes after the last number it
  acknowledged, so an ack never drops a read no take returned.
- `{"t":"ack","log":L,"upTo":S}` drops the reads up to S once the host released them, so a release that failed is
  taken again with the next answer. `L` names the program's log: a new one means a restart, and the host withholds
  that answer; an ack for another log, or past what was handed out, drops nothing.
- A version read again while it waits unread is not logged twice; read again after it was handed out, it moves to the
  end under a new number; acknowledged, it is logged again. So each answer's release names what its commands read.
  A lookup or `stat` is not a read. A waiting read costs about 0.6 KB in the folder unit's memory.

The node's listings carry each entry's receipt for an agent's view: from the core's listing, or, for a path the feed
brought, the path's earlier receipt or the nearest folder's above it that has one; a new receipt (after an access
change) reaches the machines like any change, which drops their cached pages for those paths. A stale receipt costs
the core a per-path check at release, never a wrong record. A read with none (a new top-level path, until the next
listing) is sent by the native host with the nil-uuid stand-in (resource `00000000-0000-0000-0000-000000000000`,
revision 0, no grant), which the core checks the same way (proposal P9 for F1: let the release take a read without
one). The receipt check is exact (four fields), so the core and the folder service
change together. Proof: the folder program's FUSE test, the service tests, and the systemd proof taking the log as the
native host.

**2b-3, the tools (this draft, on top of 2b-2).** `exec_command` and `write_stdin` in the `qorpera` namespace
(`packages/runtime/src/cloud-run-box-tools.ts`), shaped like Codex's own and run by the native host, never by the
harness:
- Offered only to a folder-v2 run on a host that gives runs a box. The shared execution service names the slot's two
  sockets in the native host's environment (`QORPERA_RUN_BOX_SOCKET`, `QORPERA_RUN_BOX_READS`) while boxes are on.
- `exec_command {cmd, workdir?, yield_time_ms? (default 10 s, at most 30 s), tty?}` answers when the command ends or
  the wait passes; a command still running keeps its session for `write_stdin {session_id, chars?, yield_time_ms?
  (default 250 ms)}`. The answer says how the command stands, then its output: all of it, or its start and end with how
  much was left out and where the whole of it is in the box. It is fitted to what one 8 KiB result holds whole, with
  the envelope's provenance and its second escaping of `<`, `>` and `&` counted, cutting from the middle so the end of
  the output is the last to go.
- Each answer takes the box's read log after the last acknowledged number and releases it with the run actor
  (`CloudCompanyFolderClient.release`, P8), under the hash of the exact text shown, before the model sees it; it cites
  the release (`companyReadId`), so the next model request's context view does, and only then acknowledges. More than
  one release's worth goes in several under the same hash; no reads, no release. A read the run may no longer make
  withholds the answer (`READ_REVOKED`), and everything the box would show after it in the run: what it read may sit
  anywhere in the box now (a copy in `/tmp` shows without a new read), so later calls run nothing and say why. A
  release that cannot be recorded withholds the answer too, and its reads go with the next answer. A withheld answer
  says the command ran (and its session, if it still runs). A read without a receipt goes with the nil-uuid stand-in,
  which the core checks again. The box's own error messages are not shown: the native host words them from the
  request.
- The host learns the log's id before the run's first command, so a folder restart during any command shows as a new
  log: that answer is withheld (its reads are gone), and the next goes on with the new log.
- Review class "read" (no network, the folder read-only); observed as `exec_command` and `write_stdin` (migration
  `20260929999970`, TypeScript and SQL). SQL test 802 proves the path on the live functions: the run actor opens the
  box, the view lists with receipts, the run actor releases them, the context view cites the release; a view's own
  release is not citable; a stale or empty receipt is checked again; a snapshot-v1 company refuses the box with the
  text the service knows it by.
- No prompt change yet: the tool descriptions carry it. The `company_*` tools retire at step 3.
- The systemd proof runs these tools, as the native host account, against the real box.

## Not in step 2

Writes; company, coding and test machines. Each is a later step.
