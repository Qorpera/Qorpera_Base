# Office folder remount proof

This is the Q3 proof for F3 step 4d in
[`RUNTIME-FOLDER-COMPANY-MACHINES.md`](../first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md):
when systemd restarts the office's company folder program, do the office
namespaces that are already running see the new mount? It is not completion of
4d, an office image release, or live-company acceptance.

The real `qorpera-folder` program runs under master's mount unit. Only the unit's
paths are moved to #1047's `/run` layout, and it talks to a synthetic protocol-3
node on a Unix socket. The office namespaces are started by the runtime's own
process gate (`cloud-company-computer-linux-process.ts`, types stripped) with
mirrored bubblewrap arguments, from a relay that carries every confinement line
of master's office unit. No plumber, credentials, vsock identity, SQL or model is
claimed.

## Run

All builds and checks run through `run-on-node`, not on a developer Mac. The
staged office images stay on node01's test machine, so the wrapper refuses any
other host. Start it from a clean, pushed tree:

```sh
node scripts/run-on-node.mjs --machine node01 --sudo --no-install --no-status -- \
  bash scripts/prove-office-folder-remount-vm.sh [--image <fingerprint>] </dev/null
```

The wrapper:

- checks the staged unified image `/var/lib/qorpera-office-stage/<fp12>/img.tar.gz`:
  a regular file, not a link, whose sha256 is the fingerprint;
- creates its own LXD project and directory-backed pool, imports the image into
  that project only, and boots a VM from it with no profile and no NIC
  (`-d root,size=81GiB`, since A1's disk is 80 GiB; the dir pool keeps it sparse);
- installs nothing in the guest. It loads the FUSE module only inside the nested
  VM, and only if `/dev/fuse` is missing (`fuse: loaded`, else `present`);
- logs the office service's state after boot. A1 starts its office at boot, and
  with no boot credentials `Restart=on-failure` can hold it in auto-restart. Only
  that loop is stopped, and the log says so;
- builds the folder program and requires its sha256 to match
  `deploy/folder-service/folder-program-linux-x64.json`;
- runs `scripts/test-office-folder-remount.mjs --execute` against the VM.

Its trap deletes only what it created: the VM, every image in its own project,
the project and the pool. It then prints the evidence JSON between
`OFFICE_FOLDER_REMOUNT_EVIDENCE_BEGIN` and `OFFICE_FOLDER_REMOUNT_EVIDENCE_END`
and fails the run if the test machine changed. The before/after diff covers its
links, nft tables, forwarding and conntrack sysctls, `br_netfilter`, its kernel
modules (none gone; no bridge, tun, macvtap, vhost or fuse module new) and a
`stat` of the stage folder and its files.

The launcher refuses to run unless the guest is a separate KVM boot, the office
service is stopped, and both `/etc/qorpera-office/credentials` and
`/etc/qorpera-office/boots` are empty. It records the file names it finds there,
never their contents. The fixture's preflight checks again inside the guest.

## The image under test

The default image is A1: fingerprint
`9a4935f853ae27b80bb8d2fd8cbe33d1cb3db68bbfe0d47469bb0ebdbbf20f01`, built at
commit `c1ac31535`. **A1 predates folder-v2.** The proof therefore does not use
any folder program or folder unit the image may carry:

- the `qorpera-folder` program is built from this tree and pushed in;
- the mount unit is master's `deploy/folder-service/qorpera-folder-mount@.service`,
  pushed in, with only the lines that name `/etc` and `/srv` moved to #1047's
  `/run` layout, the synthetic node's socket, and no `[Install]`. It still runs
  as root with `CapabilityBoundingSet=CAP_SYS_ADMIN`, `Restart=on-failure`,
  `RestartSec=5s` and `RestartPreventExitStatus=3`;
- the relay takes its confinement lines from master's
  `deploy/lxd-company-computer-guest/qorpera-company-computer.service`, pushed in.

What A1 itself supplies is the kernel, systemd, bubblewrap, tini, node, python,
the mount tools, any `fusermount`, the `qorpera-office` account, and how `/run` is
mounted. The record's `guestImage` part keeps what A1 carries beside master's:
the installed office unit's sha256 and its diff against master
(`officeUnitSha256`, `officeUnitAgainstMaster`), what is in `/opt/qorpera-folder`
and which `qorpera-folder*` units exist (`imageFolder`), `/run`'s mount options
(`runMount`) and which of `fusermount` and `fusermount3` exist. The top-level
`image` is the fingerprint the VM was made from.

4d's acceptance reruns this harness on the 4d generation with
`--image <fingerprint>`, once that image is staged. Building that image is 4d's
work, not this proof's.

## What the JSON establishes

The fixture prints one record. `result` is `passed` only if all nine checks
below are present and passed and nothing raised. The three office namespaces
(the desktop, shell and command shapes) are started **before** the first mount,
through the candidate form 4d-2a (#1070) uses: the folder's shared parent bound
at `/run/qorpera-company`, with `/company` a symlink to
`/run/qorpera-company/company`.

| Check | Passes when |
|---|---|
| `officeFirstPropagation` | after the unit's first start, each namespace reads the node's `before.txt` through `/company`, and its write reaches the node |
| `restartedBySystemd` | after the daemon is killed (`SIGKILL` to its main PID), systemd starts it again with a new PID and `NRestarts` one higher, and the host serves exactly one mount within 30 s |
| `oneMountAfterRestart` | after each kill, the host has one mount at the mountpoint and each namespace sees one at `/run/qorpera-company/company`: no stacked dead mount |
| `runningNamespacesRecovered` | after the first kill, each namespace is the same process in the same mount namespace, reads a file only the new mount can know, and its new write reaches the node |
| `directBindNegativeControl` | a namespace that binds the FUSE mount itself (not its parent), started once it was served, read `before.txt` before the kill and gets `ENOTCONN` after it: a bind of the mount itself does not follow a restart |
| `stateFolderKept` | the view's state folder keeps its inode and every name across the restart |
| `secondRestartRecovered` | the same holds after a second kill through `systemctl kill -s KILL` |
| `exitThreeNotRestarted` | when the node closes the view (`VIEW_CLOSED`), the program exits 3, and 9 s later systemd has not restarted it and nothing is mounted |
| `fixtureProtocolClean` | the synthetic node logged no protocol error and no client request failed or went unanswered |

## Recorded, not pass or fail

These are under `recorded` in the JSON. They describe the substrate for 4d's
design; none of them decides `result`.

- `gap`, `mode`: the bare mountpoint before any mount, per mode (below).
- `kill1`, `kill2`: each restart's unit state before and after, how long the host
  took to serve one mount again (`hostServedAfterSeconds`), how long the desktop
  namespace's watcher took to see it (`namespaceServedAfterSeconds`), each
  distinct state the watcher saw in between (`namespaceSawMeanwhile`), and the
  unit's journal.
- `staleCwd`: the command namespace's working directory inside `/company` from
  before the kill: listing it after the kill, then `chdir` again and listing.
- `oldDescriptor`: a read descriptor the desktop namespace opened before the
  kill: `pread` and `close` on it after.
- `loss`: what open writes lose (next section).
- `officeStartedOverMount`: two more relays start a command namespace while the
  folder is already mounted, one with the office unit's lines as they are and one
  with `ReadWritePaths=` for the folder's mounts. `ProtectSystem=strict` makes
  what exists at a service's start read-only, so this shows whether an office
  started over a mounted folder can write it, and whether it survives the second
  kill.
- `firstMount`, `directStart`, `directAfterKill2`, `afterExitThree`,
  `relay1BeforeLayout` and each namespace's start: the context the checks read.

Beside `recorded`, `guestImage` holds what A1 carries (above), `relayConfinement`
the office unit lines the relays run under, `officeLinesLeftOut` the lines that
run the application rather than confine it, and `mountUnit` the unit text the
proof installed.

## The loss case

A restarted program opens its view with an abandon hello, so the node drops
every handle the killed program held open. Whatever a writer had not committed
by then is lost, **whether or not the running namespaces see the new mount**:
this is a property of the restart, not of the mount's propagation, so it holds
for any office remount design.

Before the first kill, the command namespace leaves these writers open. The
synthetic node follows protocol 3: a truncating open empties the file at once, a
new file exists empty from its open, and nothing reaches the file before a
commit. After the restart, the namespace closes the old descriptors and the
fixture reads what the node holds:

| Writer before the kill | What is lost | The file after the restart |
|---|---|---|
| new file, written, not synced | the write | exists, empty |
| new file, written and `fsync`ed | the write: `fsync` sends parts, not a commit | exists, empty |
| existing file opened with truncate, written and `fsync`ed | the old content (at open) and the write | empty |
| existing file opened in place, two bytes rewritten and `fsync`ed | the rewrite | `saved before`, as before |
| new file written and closed before the kill | nothing | `closed` |

The record keeps each step's reply, what the node held before the kill
(`nodeBeforeKill`), the closes after it (`closesAfterKill`), what the node holds
after (`nodeAfterRestart`), the node's `abandoned` entries, and `asExpected`. A
mismatch is recorded, not a failed check.

## The gap before the first mount

An office that boots before its folder is mounted already holds the shared
parent, so `/company` leads to the bare mountpoint
`/run/qorpera-folder/mounts/<view>/company`. Its mode decides what the office
sees there, and whether it can write into a directory the mount will later hide.
#1047 creates it `0700`. The candidate is `0000`, kept only if the mount still
comes up over it with the unit's real mount user: root bounded to
`CAP_SYS_ADMIN`, through the program's own mount path and mountpoint checks.

The fixture measures every mode in the order `0000`, `0700`, `0755`, each in its
own view. For each it records the bare mountpoint's mode and owner, then starts a
command namespace and a shell spawned with `--chdir /company` before the mount,
and has them look and write. It starts the mount unit, waits up to 15 s for it
to serve, and has them look and write again, beside the unit's state and journal.
The rest of the run uses the first mode that was served; if none was, the run
stops there.

## Limitations

The record lists these under `limitations`:

- The node is a synthetic protocol-3 node on a Unix socket: no database, vsock
  identity, view switching or plumber.
- The office namespaces come from the runtime's process gate and mirrored
  bubblewrap arguments, in a relay that runs under the office unit's
  confinement, not from the office application. `test-office-folder-remount.mjs`
  pins the runtime lines the shapes mirror and refuses to run if they changed.
- The private surfaces (workbench, home, screen, X11, session, machine-id, hosts,
  resolv.conf) are stand-ins in the proof directory, not the office state folder.
- Every namespace's program reads requests on a stdin pipe; the command shape is
  used without its display or capture.
- `systemd-run` takes the office unit's `InaccessiblePaths=` lines as transient
  properties, where unit specifiers are not expanded.
- A1 predates folder-v2: the folder program and the mount unit's lines were
  pushed in from master.

## Unprivileged checks

`scripts/test-office-folder-remount.test.mjs` runs in `run-on-node changed`. It
checks the launcher's argument and target refusals, the guest preflight, the
runtime pins, the shapes' descriptor arithmetic, that the type-stripped process
gate loads, and the fixture's `selftest`: the unit rewrite, the office lines,
mountinfo reading, and the synthetic node's wire with a real heartbeat, without
privilege.
