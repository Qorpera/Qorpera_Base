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
| Folder program, `bridge` | the same binary | node host, `qorpera-folder-bridge` | nothing |
| Folder service | `packages/object-gateway/src/folder-service` (Node) | node host, `qorpera-folder` | the service credential; each view's tree, chunks and manifests in memory |

The bridge exists because Node has no `AF_VSOCK`. It listens on vsock port 5250, takes the peer's CID from the
kernel (LXD assigns it; a machine cannot choose it), sends it as the first frame on the service's Unix socket, then
passes bytes through untouched. Only the bridge's account can open that socket (systemd socket, 0660, group
`qorpera-folder-bridge`).

Nothing is written anywhere. A restart of either side refetches. A node's crash loses nothing that was saved (step
1 saves nothing).

## Protocol v1

A frame is a u32 big-endian length (of the type byte plus payload), one type byte, the payload; at most 2 MiB of
payload. Control messages are JSON; a read reply is the bytes. Rust: `crates/qorpera-folder/src/{frame,proto}.rs`;
TypeScript: `packages/object-gateway/src/folder-service/protocol.ts`.

| Type | Direction | Payload |
| --- | --- | --- |
| `B` | bridge → service, first and only once | `{cid}` |
| `H` | machine → service, first from the machine | `{protocol: 1, environmentId, viewId, pass, role: "io" or "feed"}` |
| `h` | service → machine | `{protocol, viewId, asOfSeq, readOnly: true}` |
| `L` / `l` | io | `{path, after?}` / `{entries: [{name, kind, size, mtimeMs, executable, version}], next?}`, 1,000 per page, names in UTF-8 byte order |
| `R` / `d` | io | `{path, version, offset, length ≤ 1 MiB}` / the bytes |
| `c` | feed, service → machine | `{seq, resync, paths}`; no paths is a heartbeat (every 15 s) |
| `a` | feed, machine → service | `{seq}` |
| `e` | service → machine | `{code, message}` |

Error codes and what a program on the machine sees: `NOT_FOUND` ENOENT, `NOT_A_FOLDER` ENOTDIR, `NOT_A_FILE` EISDIR,
`STALE` ESTALE, `DENIED` EACCES, `BAD_REQUEST` EINVAL, `UNAVAILABLE` EIO. `VIEW_CLOSED` and `VIEW_REFUSED` unmount
the folder; the program exits 3 and its unit does not restart it.

A read names the version the machine was shown. The service serves exactly that version: the current one, or one
replaced on the feed within the last 60 s (so a file opened before a change reads to its end). Later it is
`STALE`. An access change forgets replaced versions at once.

## Who may connect

Step 1 has no view rows: the core's view kinds need a leased run, an office screen or a coding session (C1b-3a).
Its mounts are named in the node's configuration instead (`mounts` in `config.json`): an id, the company's folder-v2
environment, the actor (`{kind: "member", userId}` or `{kind: "platform"}`), the machine (LXD project, name and
`volatile.uuid`) and the sha256 of the pass. A hello opens the view only if:

- the pass hashes to the configured value (compared in constant time);
- the environment matches;
- LXD, asked on every connection, says the named instance is Running, its `volatile.vsock_id` is the peer's CID,
  and its `volatile.uuid` is the configured one. Nothing is cached: a restarted machine may get another CID.

Every refusal is the same `VIEW_REFUSED`. The pass is made inside the machine and never leaves it; the node keeps
only its hash.

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
is used or kept. Chunks and manifests are kept in a least-recently-used memory cache (1 GiB by default). Sixteen
reads run at once, each with a 30 s deadline. Committed objects are never collected (C1d-2a roots every path
version), so a reader holds no lease.

The company's storage profile is not in list, read or feed answers. The service learns it once per company through
`qorpera_folder_authorize_object_download` on the first file read (P2 below proposes a direct way).

The folder program fetches a folder's listing when the kernel first asks for one of its names, keeps it, and
answers from it until the feed says the folder changed. Inode numbers are never reused while it runs. The kernel
keeps names and attributes for an hour and file pages across opens, and is told to drop exactly what changed. There
is no kernel listing cache (`FOPEN_CACHE_DIR`): the kernel keeps it while the folder's time is unchanged, and
adding a file does not change it.

## Staying current

- The service reads `qorpera_folder_clocks` (service_role select, C1f) every 500 ms for the companies with live
  views. When a clock moved, each view reads the feed from its position and pushes the changed paths.
- An access change on the feed (`{seq, kind: "authority"}`), or a position the core no longer serves, lists the
  view again; the difference is pushed. More than 5,000 changed paths are sent as a resync.
- Grant expiry, member removal and agent archive are on no feed. Each view is listed again every 10 minutes, and
  a denial (42501) closes the view on every connection.
- The folder program treats 45 s without a frame as a dead link. While its feed is down it caches nothing and gives
  the kernel nothing to keep, so it never shows an older version than the node's. When the feed is back it drops
  everything once and carries on.

## Tests

`node scripts/run-on-node.mjs changed` runs the step `folder-program` on the node 2 test machine (it has no Rust):

- in `rust:1.95.0-slim-bookworm` (pinned by digest): 22 unit tests, and two FUSE tests that mount for real against
  a stand-in node (listing, reads, read-only refusals, the page cache, a change shown at once, a new file, a removal,
  a feed that breaks and comes back, a view closed, a view refused);
- then the built program in `node:24.21.0-bookworm-slim` against this package's folder service with a stand-in core
  and share (`packages/object-gateway/test/folder-mount-e2e.test.ts`): a 3 MiB file across chunks, a member's edit
  shown in under a second, a folder taken away disappearing, SIGTERM unmounting.

The service's own tests (`packages/object-gateway/test/folder-service.test.ts`) cover the protocol checks, the tree,
the share reader (tampered chunks, links, mismatched manifests) and the service over its socket (refusals, a second
bridge frame, paging, stale versions, access changes, closing).

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

## Rollout (coordinator)

Changes: two new units and a socket on each node host, one new unit in the execution host. No runtime bundle, image,
provider, SQL or LXD configuration change; the node inventory is unaffected (no instance or device change). Safe for
the running bundle.

1. Read-only prechecks, both nodes:
   - `ss -l --vsock` shows nothing on port 5250; `lsmod | grep vhost_vsock`.
   - `stat -c '%U %a' /srv/qorpera/canonical/<a profile>/<an object>` and which account the gateway writes as; decide
     the folder service's read access (README).
   - In the execution host: `ls -l /dev/fuse; grep fuse /proc/filesystems`.
   - `lxc config get qorpera-exec-node02 volatile.uuid --project qn25b2`.
2. Build and package on the node 2 test machine from the release commit (README); record both sha256 values.
3. Node 2 host: install, write `config.json` and the key, enable the socket and the bridge. Node 1 host: the same,
   with an empty `mounts` list (node parity compares every `qorpera-*` unit).
4. Execution host on node 2: guest installer, view file, `systemctl start qorpera-folder-mount@proof`.
5. Acceptance (the design's step 1 proof), as root in the execution host:
   - `find /srv/qorpera-folder/proof | wc -l` equals the proof company's path count, and
     `rg -l <word> /srv/qorpera-folder/proof` finds what the web app's search finds;
   - a member's edit in the web app shows in `cat` within about a second (waits on C2–C4);
   - a folder taken away from the mount's actor disappears within about a second;
   - a slot account gets `Permission denied` on `/srv/qorpera-folder`;
   - node 2 stays `ready`; the folder service's journal shows no integrity error.
6. Rollback: stop the mount unit (it unmounts), then disable the bridge, the socket and the service. Nothing else is
   kept.

## Not in step 1

Writes; the run box and `allow_other`; company, coding and test machines; hiding `/srv/qorpera-folder` in the slot
units; carrying the folder program in the shared-execution package (so it survives an image rebuild). Each is a
later step.
