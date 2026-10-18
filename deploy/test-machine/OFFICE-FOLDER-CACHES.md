# Office folder caches proof

This is MC3c's node e2e for
[`RUNTIME-FOLDER-MACHINE-CACHES.md`](../first-node/RUNTIME-FOLDER-MACHINE-CACHES.md):
do the office's folder mounts keep their caches (a worktree's `node_modules`) on
the machine's disk, each in its own private folder, does a restarted machine
find them, and does a closed view end its mount within the bound? It is not an
office image release or live-company acceptance.

Master's folder helper (`packages/runtime/src/cloud-company-computer-folder-helper.ts`,
bundled with esbuild as the company computer package bundles the runtime) mounts
and drops. Master's office mount unit runs the real `qorpera-folder` program, with
only its program and a synthetic protocol-4 node on a Unix socket put in. No
plumber, credentials, vsock identity, SQL or model is claimed.

## Run

All builds and checks run through `run-on-node`, not on a developer Mac. The
staged office images stay on node01's test machine, so the wrapper refuses any
other host. Start it from a clean tree:

```sh
node scripts/run-on-node.mjs --machine node01 --sudo --no-status -- \
  bash scripts/prove-office-folder-caches-vm.sh [--image <fingerprint>] [--unpinned-program] </dev/null
```

Not `--no-install`: the launcher bundles the helper with the repo's esbuild.

The wrapper works as the remount proof's does
([`OFFICE-FOLDER-REMOUNT.md`](OFFICE-FOLDER-REMOUNT.md), "Run"): its own LXD
project and pool, the staged image imported there only, a VM with no profile and
no NIC, FUSE loaded only inside the nested VM and only if `/dev/fuse` is missing,
the office's boot-time restart loop stopped, the folder program built from this
tree, and a before/after diff of the test machine. Then it runs
`scripts/test-office-folder-caches.mjs` twice:

1. `--phase first`: the guest proof's first phase (below). If it passed, the
   fixture's `pause` takes away everything in `/run` and keeps the program's
   home and the caches on the guest's disk; otherwise `cleanup` takes away all
   it claimed.
2. `lx restart`: `/run` is gone, the disk stays.
3. `--phase second --first <the first record>`: refused unless the first phase
   passed on the same VM, image and program, and the guest booted again. Then
   `cleanup`.

The evidence JSON (the second record, holding the first) is printed between
`OFFICE_FOLDER_CACHES_EVIDENCE_BEGIN` and `OFFICE_FOLDER_CACHES_EVIDENCE_END`.

**The program pin.** The wrapper requires the built program's sha256 to match
`deploy/folder-service/folder-program-linux-x64.json`. A program built before
MC3a refuses `--cache-dir`, so the proof can pass only once MC3a is merged and
the record re-pinned. `--unpinned-program` is a dry run against a branch's
program: the wrapper logs both digests, the record says `programPinned: false`,
and the run is never the proof.

## The guest proof

`scripts/fixtures/office-folder-caches.py` runs as root in the guest, under
`systemd-run` with a `RuntimeMaxSec` (first 900 s, second 300 s). It refuses to
run outside a KVM guest, on the shared test VM, outside
`/run/qorpera-caches-<uuid>`, with office credentials or boots, with the office
service running, or with a `/run/qorpera-folder` it did not make. Before the first
phase `/var/lib/qorpera-folder/cache` must not exist; it is claimed (or
`/var/lib/qorpera-folder` itself, when the image has none) and removed by the
final cleanup.

- **The helper** is bundled from this tree
  (`scripts/fixtures/office-folder-caches-helper.mjs`). Each request is a new
  helper process, as after a helper restart: `line` hands it the request line as
  the helper's socket does (an unparsed line is `invalid`), `direct` hands the
  request object past the parser. Only the unit's name is the proof's
  (`qorpera-caches-folder-mount@<name>`), since an image's own office unit in
  `/etc` would shadow one of the office's name in `/run`. The helper's
  `publish`, `launch` and `relay` throw: nothing is published or relayed.
- **The unit** is master's
  `deploy/lxd-company-computer-guest/qorpera-office-folder-mount@.service.in`,
  rendered with the office account's ids, with `ExecStart`'s program and node
  changed (the remount proof's `proof_unit`). It keeps `EnvironmentFile=`, so the
  program gets `--cache-dir` from the helper's `units/<name>.env`.
- **The node** is the remount proof's synthetic node with nested folders
  (`code/o/n/worktrees/w`, `code/o/n/repo.git`, `docs`), a `switchable` answer
  for desktop views, and a closed view refused on every request, as the core
  refuses it.
- **The office** is a process of `qorpera-office`; each read is a new process,
  so nothing it opened earlier helps it.

## What the JSON establishes

`result` is `passed` only if every check below is present and passed and
nothing raised. A cache key is one file the office writes into
`code/o/n/worktrees/w/node_modules`: `x` from the desktop, `a` and `b` from
commands of two owners. On the disk it is at
`/var/lib/qorpera-folder/cache/<cache>/caches/d/code/d/o/d/n/d/worktrees/d/w/t/node_modules/<key>`.

### First phase

| Check | What it measures |
|---|---|
| `cacheFlagPassed` | A desktop mount's program runs with `--cache-dir /var/lib/qorpera-folder/cache/desktop`, from the helper's `units/<name>.env` (root's, `0600`). |
| `cacheOnMachineDisk` | The office makes `node_modules` and writes `x`: it reads back, lands in the desktop cache on the disk, not in the mount's state folder, and no node request names `node_modules`. |
| `ownerIsolation` | Owner a's command and owner b's command each find no other cache's file (`ENOENT`), b's listing has no `node_modules`, the desktop finds neither a's nor b's, and each file is on the disk once, in its own cache. |
| `sameOwnerFindsCache` | After a's first command is dropped, a's next command reads `a`, and still not `b` or `x`. |
| `cacheDirsPrivate` | `/var/lib/qorpera-folder`, `cache`, `cache/desktop` and each owner's folder: real folders, root's, `0700`. |
| `mismatchRefused` | A desktop given an owner's cache, and a command given `desktop`, `../desktop` or nothing, are `invalid`, through the line and past the parser, and leave no view, env file, mount, state or unit. |
| `badCacheDirRefused` | The program, run by hand, exits 1 with `FOLDER_CACHE_DIR_UNUSABLE: <dir>: <why>` and mounts nothing, for a cache folder that is `0755`, a link, the office's, relative, missing, over 80 bytes, the state folder (it holds the local folder, `<state>/local`), or inside the local folder; each with the program's reason. |
| `directControlMounted` | The same run with a good folder mounts, and exits 3 when its view closes. |
| `helperRefusesForeignCacheDir` | The helper answers `failed` for an owner's cache folder that is a link or the office's, says hello to the node for neither, leaves nothing behind, and changes neither folder. |
| `closedViewReadsFail` | Row 1 below. |
| `mountEndsWithinBound` | Row 2 below. |
| `heldFilesEndWithMount` | Row 4 below. |
| `boundCatchesLiveMount` | Row 3's live must-fail below. |
| `fixtureProtocolClean` | The synthetic node saw no protocol error, and every drop answered. |

### Second phase, after the restart

| Check | What it measures |
|---|---|
| `machineRestarted` | The guest's boot id differs from the first phase's. |
| `restartFindsCaches` | A new desktop reads `x`, a new command of owner a reads `a`, one of owner b reads `b`, and each lists only its own key. |
| `ownerIsolationAfterRestart` | Each of them still finds no other cache's key (`ENOENT`). |
| `cacheDirsPrivate` | As in the first phase. |
| `fixtureProtocolClean` | As in the first phase. |

## The revocation rows

In the product the service renews each open view every 40 s and pushes a
closure. A command's program exits 3 at once; a desktop's (its view is
`switchable`) waits a 60 s grace for a switch, then exits 3. The unit's
`ExecStopPost` lazy umount takes the mount away, and `RestartPreventExitStatus=3`
keeps systemd from starting it again (`Restart=on-failure`, `RestartSec=5s`).
So the product's bound from a revocation is a desktop's 40 + 60 s and a
command's 40 s.

The synthetic node pushes the closure itself, so the proof measures from the
push: `BOUND` is 10 s for a command and 75 s for a desktop (the grace plus its
slack). Before the closure, one long-lived office process opens and holds three
things in the desktop's mount and in owner a's command's: its cached key, the
node's `README.md`, and the cache folder `node_modules` itself.

| Row | Check | Passes when |
|---|---|---|
| 1 | `closedViewReadsFail` | Right after the closure, a new office process reading `published.txt` (never read before) or `docs/guide.md` through either mount is refused with an errno within 5 s, and the node refused each of the views' requests. |
| 2 | `mountEndsWithinBound` | Each program exited 3, was not restarted (still so 9 s after its exit, past `RestartSec`), and its mount is gone (no copy in mountinfo, not served), all within its bound; a new read of the cached key through the mountpoint is refused; and the key is still on the disk in its cache. |
| 3 | `boundCatchesLiveMount` | The must-fail, live: a third command (a fresh owner) whose view the node does **not** close is still mounted and served when its 10 s bound passes, and row 2's test (`ended`) fails it. The node then closes it, and the same test passes it within 10 s of that closure. |
| 4 | `heldFilesEndWithMount` | After the end, every held descriptor (`pread` on the cached key and on `README.md`, and `openat` of the key in the held `node_modules`) is refused with an errno. |

What the grace serves before the end is recorded, not required (below). Row 3's
other must-fail, a program with a longer grace or no exit, would need a changed
Rust program, so it is in the `selftest`: `ended` refuses a desktop that exits at
90 s against its 75 s bound, a command at 10.6 s against 10 s, a program that
never exits, a mount that is still served or still in mountinfo, a restart, and
an exit other than 3.

## Recorded, not pass or fail

These are under `notes`; none decides `result`.

- `kernelCache`: the program's `kernel cache on|off` log line for the desktop
  mount.
- `duringGrace`: what each mount still serves right after the closure, before
  its end: the held descriptors, a new open of the cached key, and a new open of
  `README.md`, which was read before the closure. A read the node would have to
  answer is refused (row 1); this shows what the machine itself still holds.
- `desktopExitSeconds`: when the desktop's program exited after the closure.

The record also keeps `nodeHellos`, the last 300 of the node's requests
(`nodeOps`), each mount unit's journal, the guest kernel's messages since the
phase began (`kernelDenials`), and `missingChecks`.

## Limitations

The record lists these under `limitations`:

- The node is synthetic: it pushes a view's closure itself, so the bound is
  measured from the push; the service's 40 s renewal comes before it in the
  product.
- Each helper request is a new helper process, as after a helper restart; the
  helper's socket, the office application and its namespaces are not part of
  this proof.
- A longer grace cannot be built without the program's Rust: that must-fail is
  the `selftest`'s; the live one is a closure the node never pushes.

Also: the image under test is A1, which predates folder-v2; the proof brings
master's unit and this tree's helper and program, and starts no office service.

## Unprivileged checks

`scripts/test-office-folder-caches.test.mjs` runs in `run-on-node changed`. It
checks the launcher's argument and target refusals, that the second phase runs
only after a first that passed on the same VM and program in a new boot, that
the pushed sources exist and parse, that the bundled helper drives only the
proof's units and never publishes, launches or relays, and the fixture's
`selftest`: `ended`'s passes and must-fails, the refusal tests, the unit's
`EnvironmentFile=` and `--cache-dir` lines, the private-folder tests, the office
client, and the synthetic node's wire with a closed view, without privilege.
