# Test machine folder proof

This is P4 for F3 step 6 in
[`RUNTIME-FOLDER-TEST-MACHINES.md`](../first-node/RUNTIME-FOLDER-TEST-MACHINES.md):
an agent's test machine works with the company folder, end to end. A command an
agent runs on its machine reads and writes `/company`, what it changed is
committed under that command's credit, and its output reaches the caller only
after a boundary answers `released`. It is not an image release, a node rollout
or live-company acceptance.

Step 6f makes it the live proof of the plan's step 6 tests: the v2 binding and
the receipts' `companyFolder`, the quiet publish of a running loop, a writer
left running after its command ended, a stop while a program writes, a machine
whose starter does not read the root, the reverse (a boot-time service dropped
with the unchecked disk), a starter narrowed while its machine runs, and the
host's vsock ports as a guest sees them.

The path is the product's own, from the gateway call down:

1. the machine command gateway's HTTP call (`createHttpCloudMachineCommandGateway`)
   into the executor's command service (`HttpCloudCodingCommandService`, with
   `machines`), which proves the run's holder (`qorpera_native_binding_proven`)
   and asks `qorpera_authorize_machine_command`
   (`deploy/coding-worker/machine-command-authority.ts`), then routes the command
   (`machine-command-routing.ts`);
2. the executor's test machine host, `LxdCompanyMachineHost` with a
   `UnixFolderControl` (6d-1), on the real LXD socket, and its pass loop;
3. an LXD VM made from a test machine image (6c's guest package: the helper, its
   units, the pinned folder program and its unit);
4. the folder service (6b) in this process, on its control and folder sockets,
   with the real `qorpera-folder bridge` on vsock port 5250, serving a
   `test_machine` view (6a);
5. the folder core in Postgres: every migration of the tree, applied by the
   hosted database harness.

The callers' runs are real: three runs of the 924 base company (Alice, Bob and
Carol, as SQL test 628 sets them up), each made by the folder materializer and
started through the real claim, runner and native lease, each with a lease
token of its own.

## Run

All builds and checks run through `run-on-node`, not on a developer Mac. The VMs
are nested in node01's test machine, in a project and pool the wrapper claims
for the run. Start it from a clean tree:

```sh
node scripts/run-on-node.mjs --machine node01 --sudo --no-status -- \
  bash scripts/prove-test-machine-folder-vm.sh </dev/null
```

The wrapper:

- refuses any host but a node's test machine with `/dev/kvm`, a local LXD on its
  Unix socket, 16 GiB free and nothing listening on vsock port 5250;
- creates its own LXD project and directory-backed pool (`qtm-<8 hex>`);
- builds the folder program and requires its sha256 to match
  `deploy/folder-service/folder-program-linux-x64.json`, then packages the
  machine guest with it (`scripts/package-machine-guest.mjs`);
- builds the stand-in image (below) in that project, from `ubuntu:26.04`, and
  publishes it there;
- runs `scripts/test-test-machine-folder.mjs --execute` against the project.

Its trap deletes only what it created: every VM and image in its own project,
the project and the pool. It then prints the evidence JSON between
`TEST_MACHINE_FOLDER_EVIDENCE_BEGIN` and `TEST_MACHINE_FOLDER_EVIDENCE_END`.

The host diff is the last thing it does, with the project and pool gone. It
prints a block between `TEST_MACHINE_HOST_DIFF_BEGIN` and
`TEST_MACHINE_HOST_DIFF_END`: the test machine's state before the run (its
links, nft tables, forwarding and conntrack sysctls, and
`bridge-nf-call-iptables`), then either the diff against the state after or the
line `host state unchanged`, then the kernel modules' result (`no module
appeared or disappeared`, or a `FAIL:` line for each module gone, or each
bridge, tun, macvtap, vhost, vsock or fuse module new). A diff or a `FAIL:`
line fails the run. The guest loads FUSE only inside the nested VM, and only if
`/dev/fuse` is missing.

## The steps

Each step's evidence is in the record under its name. They run in the order
below; the reads come before the overlap, so Bob's run has had no command on the
machine when it takes the reads in. The refusals run last on `p4` (step 9):
SQL ends K while the guest still runs it, so K's window stays open in the
service until the boot ends, and every change made on that boot afterwards is
credited to K too. The steps that take a root read away (10 to 12) run after
`p4` is removed, each on a machine of its own, and give the read back before
they end. At most two VMs run at once.

1. **`boot`.** Alice's run starts machine `p4` (`machine_start` through 628's
   `mc_start`, which makes and checks the tool's receipt). The host's pass admits
   it, creates and starts the VM, marks the boot running, opens the boot's
   `test_machine` view and hands it to the guest, whose `folder-mount` mounts
   `/company` (the outcome `FOLDER_MOUNTED`). A command of Alice's lists
   `/company`, reads the seeded `p4/seed.md` and says whether `/mnt/repository`
   exists. The record keeps the boot's placement binding (6e-1: v2, no
   repository worker), the VM's devices as LXD has them, and the start's and
   the read's receipts with their `companyFolder` (6e-2a).
2. **`credit`.** While the stand-in folder control holds every boundary and
   window close (below), a command A of Alice's run writes `p4/alice.txt` and
   prints `wrote-alice`. A gateway read of A 6 s later gets `state: running`,
   no output and no exit code, though A has ended. After the hold lifts, the
   next read's boundary answers `released`, and only that read returns the output
   and exit code 0. The commit holds `alice.txt` credited `[A]`, with actor Alice's
   agent, Alice's run and the owner as the requesting member, from the
   `test_machine` view. The service may commit `alice.txt` during the hold, after
   its 2 s quiet period, while A's window is still open: that is a commit, not
   output, so the record keeps it (`committedWhileHeld`) without judging it.
3. **`reads`.** The view's read set (`qorpera_folder_view_read_records`) and
   Alice's run's read rows (`qorpera_folder_run_read_records`), fanned out
   while her commands ran and taken in by the host at each read that let her
   output out (6d-3b). The proof then calls the take-in itself in SQL
   (`qorpera_folder_run_inherit_view_reads`): for Bob's run, whose agent's view
   it is not, and once more for Alice's run (her machine's view), which checks
   the whole set again and copies only what she had not taken in. 6a-3 lets a
   run with the company audience whose agent and member read the root take it
   in, and refuses any other with 42501 ("only with the company-wide view"). The
   fixture gives Bob's run both, so it must take the reads in: the record keeps
   what SQL says of Bob's run before the take-in (`bobAuthority`: its audience,
   its agent, and whether its agent and member read the root,
   `qorpera_folder_reads_root`) and Bob's read rows before and after.
4. **`overlap`.** Bob's run starts B, which writes `bob-only.txt`, then after 6 s
   appends to `shared.txt`. Carol's run starts C 3 s after B, which appends to
   `shared.txt` within a second and writes `carol-after.txt` 24 s later, after B
   has ended. Credits are per unit, by the windows open when the change was
   made: `bob-only.txt` `[B]` under Bob, `shared.txt` `[B, C]`, and
   `carol-after.txt` `[C]` under Carol. The service publishes each change 2 s
   after it is made, so each lands in a commit of its own; the commit's
   `units` keep no credits, so the check reads a unit's credits from its commit
   when the unit has none (`unitOf`).
5. **`vsockPorts`.** A command of Alice's connects from the guest to every
   vsock port of the host (CID 2), 1 to 65535, 64 at a time, with a 3 s
   timeout each, and prints which answered, how many timed out and the errnos
   of the rest. While it runs, the proof reads the test machine's vsock
   listeners, read-only: `ss -H -l -p --vsock` (each listener's bound CID, port
   and processes, with each process's executable from `/proc/<pid>/exe`),
   `systemctl list-sockets` (the systemd socket unit on a port) and
   `systemd-detect-virt --vm`. Every port that answered must have an allowed
   owner:
   - LXD's own listener has no fixed port (7114 nested, 1497 on the node01
     host, 8012 on the node02 host). It is allowed by owner (the lxd daemon,
     `/snap/lxd/<rev>/sbin/lxd`) and by its CID-2 binding, never by port
     number. Exactly one such port is allowed; a second fails.
   - 22 is allowed only when `systemd-detect-virt` on the test machine says it
     is a VM and the owner is systemd's `sshd-vsock.socket`. 8443 is allowed
     only when the test machine is a VM and the owner is `lxd-agent`. On bare
     metal, either port fails. Both come only from running the proof nested:
     the test machine is itself a KVM guest, with its own sshd over vsock and
     its own LXD agent.
   - 5250 must answer, and its owner must be the folder bridge this run
     started (its pid).
   - Any other port fails. So does an allowed port with a different owner, or a
     port with no owner.

   None may time out, and every port that did not answer must have been
   refused: its connect ended in `ECONNRESET` (what virtio-vsock gives a port
   nothing listens on; runs 2 and 3 had it on all 65,531 others) or
   `ECONNREFUSED`. Any other errno (`ENOBUFS`, `EAGAIN`, ...) proves nothing
   about the port and fails, and the answers plus the refusals must add up to
   the 65,535 scanned. The evidence lists every answering port with its owner,
   its bound CID, and the `systemd-detect-virt` value, and the errnos with
   their counts. `otherMachineRefused` (step 9) stays the CID check on 5250.
6. **`detached`.** A command of Alice's starts a writer with `systemd-run`
   outside its own unit, prints `started` and ends. The writer waits for
   `/run/p4-go`. Once SQL has the command's end and the host's pass has closed
   its window, and no command of `p4` runs or has a window open, the proof
   creates `/run/p4-go` (`lxc exec`), and the writer writes
   `p4/detached.txt`. No window is open when it writes, so the commit names the
   starter (Alice's agent, the boot view's run and the owner) and credits no
   command.
7. **`loop`.** With the host's passes paused (no pass asks for a boundary), a
   command L of Alice's writes `p4/loop.txt` at each 10 s of the guest's clock
   and prints `tick <n> <ms>`; on TERM it writes and prints its last change.
   The proof measures the guest's clock against its own (`lxc exec date`) to
   place L's ticks on the host's clock.
   - For three ticks nothing asks for a boundary (the record counts the
     boundaries and window closes asked then: 0). Each change is committed by
     the service's quiet publish, 2 s after it was made.
   - A gateway read of L is aimed 600 ms after a tick, less the read's measured
     lag to its boundary (up to four tries): its boundary publishes the change
     made just before it (a report `by: read` for L, saved).
   - A cancel 5 s after a tick ends L: its trap writes, and the cancel's
     boundary publishes the last change (a report `by: cancel`, saved).
   - The passes resume, and a look reads `loop.txt`'s last line.

   Every commit of `loop.txt` credits `[L]`. SQL keeps a publish that saved
   nothing too (no `seq`), and a unit can be refused or conflict in a commit
   that took one, so a commit is not a save. The record keeps each commit's
   `seq`, the unit's outcome and version, and that version's `file_sha256`.
   Each tick's own bytes (`<n> <ms>`, as L printed them) must be saved: a
   commit with a `seq` whose unit was saved as a version with that sha256,
   within 10 s of the write and not before it. A later save never stands in
   for a missing one, since it holds other bytes. The quiet ticks must be saved
   by the quiet publish, between 1.5 s and 8 s after the write (the service's
   2 s, with room for a loaded box), by a `seq` no boundary or window close
   reported. The read's `seq` is a boundary's and is the first save of a
   tick. The cancel's `seq` is a boundary's and saved L's last bytes
   (`<n> last <ms>`).
8. **`stop`.** A command S of Alice's writes `p4/stop-loop.txt` every half
   second; on TERM it writes its last line. 4 s later Alice's run stops `p4`
   (`qorpera_native_machine_manage`, `stop`). The host's stop sends the
   commands TERM, runs the final boundary with the view, closes it, powers the
   VM off and sends `restarted` for the machine; SQL has the view closed. S's
   last change, made after the stop began and less than the quiet period
   before the final boundary, is saved by that boundary's publish before the
   power-off (the LXD stop request). Alice's run then starts `p4` again: a new
   boot, a new view, and `/company` reads the files the first boot wrote and
   S's last line.
9. **`refusals`**, on the second boot.
   - Carol's command M writes `m.txt`, which is committed credited `[M]`. M
     starts only after SQL has the earlier commands' ends: a command's window
     stays open until the host's pass records its end, and a change made while
     it is open is credited to it too (one run had `m.txt` credited `[C, M]`).
   - Bob's command K sleeps 5 s, then writes `k.txt`. Right after its start
     returns, SQL ends K (`qorpera_end_company_machine_commands(machine,
     'stopped', [K])`, which sets it `lost`). The service keeps K's window open
     until the guest says K ended, so the write is credited to K; its publish
     (after the quiet period, or at the boundary of a read of M 8 s later) gets
     `k.txt` refused `command_ended`, and `k.txt` is not in the folder. A
     boundary that runs while K's bytes are still on their way answers
     `waiting` (its bytes are not saved yet); that is no answer, and the first
     outcome after it counts (run 3 had `waiting` at 464.3 s, then `refused`
     at 466.4 s). K's
     start sent again gets `MACHINE_COMMAND_ENDED` with no `lost` and no folder
     loss (`resent`), and a read of K is either refused the same way (exactly
     `MACHINE_COMMAND_ENDED`, with no `lost` and no folder loss) or answered
     with `company: mounted` and no `lost` (`read`): SQL ended K, not the
     folder. A read that got any other error (the gateway unavailable or timed
     out, `code: null`) fails.
   - SQL ends a command, not a run: a run's end alone does not end its commands,
     so their changes are still credited (the commit's run is then null). The
     brief's "a command whose run ended" is shown with the command's own end.
   - A second VM in the project, named like a machine
     (`qorpera-machine-<random>`) and made from the same image, is prepared
     through its own helper, then given the hand-over the host gave the real
     guest for the second boot (its `folder-mount` stdin, kept in memory, never
     logged). The service refuses its open `VIEW_REFUSED`: its instance is not
     the view's placement. The guest's folder program then stops for good, and
     the helper answers `closed` for the view. The real machine's next command
     still reads `/company`.

   Alice's run then removes `p4`.
10. **`noRootRead`.** Bob's agent's path grants are revoked
    (`qorpera_company_path_grants.revoked_at`, as SQL test 516 does), so it no
    longer reads the root (`qorpera_folder_reads_root` is false). Bob's run
    starts machine `p4-bare`. The core refuses the boot's open (42501, "Folder
    view needs the company-wide view"), the host's outcome is
    `FOLDER_NONE:REFUSED`, the placement is marked unchecked and no view is
    open. A command of Bob's finds no `/company` mount and nothing under
    `/company`; its start and its receipt say `company: none`, with the
    refusal's `why`.
11. **`reverse`.** Still without the root read, a command of Bob's installs and
    enables a boot-time unit, `p4-marker.service`, which writes
    `/var/lib/p4-marker`. Bob's grants are given back (the ones revoked since
    step 10), Bob's run stops `p4-bare` and starts it again. The next boot's
    open is refused because the disk was used without the folder check (the
    detail `qorpera.test-machine/new-disk`), the host retires the placement
    (`FOLDER_RETIRED:UNCHECKED`, reason `unchecked`), and the machine starts on
    a new placement with a v2 binding and `FOLDER_MOUNTED`. A command there has
    `/company` with the seed, and neither the unit nor its marker. Bob's run
    removes `p4-bare`.
12. **`narrowed`.** Carol's run starts `p4-narrow`, which mounts. Alice's run
    starts a long command on it (`a-long`, which sleeps), Carol's run one too
    (`c0`), and a read of Alice's says `company: mounted`. Then Carol's agent's
    grants are revoked while the machine runs.
    - Until the restart, every command of Carol's run on the machine is
      refused: a new command, a read of `c0` and its cancel. SQL refuses each
      with 42501 ("Machine needs the company-wide view"), which the gateway
      answers as unavailable. Alice's read of `a-long` is still answered.
    - The core closes the boot's view, and the host's outcome is
      `FOLDER_RESTART:VIEW_CLOSED`. The proof listens for the restart and for
      the retirement before the revoke, and pauses the passes at each, so a
      late restart cannot let the retirement go by unheard. It hears a restart
      with any reason (the evidence keeps it); only `VIEW_CLOSED` passes. At
      the restart pause,
      Alice's read of `a-long` shows the ended boot: `company: none` with the
      host's `why` (the view was closed) and `heldBack` (the output stays on
      the machine).
    - The passes resume. The next boot's open is refused (the new-disk detail),
      and the host retires the placement (`FOLDER_RETIRED:STARTER`, reason
      `starter`). The proof pauses the passes again, gives Carol's grants back,
      and resumes them: the machine starts on a new placement and mounts.
    - `a-long` is `lost` (`restart_view_closed`, or `moved_starter` if the move
      ended it first), and Alice's read of it is refused
      `MACHINE_COMMAND_ENDED` with that `folderLost` and the host's `lost`
      words. A command of Carol's on the new disk has `/company`. Carol's run
      removes `p4-narrow`.

## What the JSON establishes

`result` is `passed` only if every check below passed.

| Check | Passes when |
|---|---|
| `bootMounted` | the host's pass reported `FOLDER_MOUNTED`; SQL has the boot's `test_machine` view open; the first command succeeded and printed the seed |
| `v2Binding` | the boot's placement binding is `qorpera.lxd-company-machine/v2` with no repository worker; LXD lists the VM's devices, none named `repository` or at `/mnt/repository`; the machine has no `/mnt/repository` |
| `reportOnReceipts` | the boot's start and A's start say `company: mounted` with the start's `heldBack`; A's read while held has the unanswered `heldBack`; the boot's read, A's released read, the still-reads command and the second boot's read say `mounted` with no `why`, `heldBack` or `lost`; K's start sent again is refused `MACHINE_COMMAND_ENDED` with no `lost` and no folder loss, and a read of K is refused exactly the same way or answered `mounted` without `lost`; any other error on that read (the gateway unavailable or timed out) fails |
| `heldUntilReleased` | while held, A's start and a later gateway read of A both got `running`, empty output, a null exit code and a log of 0 bytes, and boundaries were asked; the read after the hold got A's output, a log with bytes and exit 0, after a boundary answered `released` |
| `creditedToCommand` | `p4/alice.txt` is committed with credits `[A]`, actor `staff_agent` Alice, run R and requester the owner, from the `test_machine` view |
| `overlapCredited` | `bob-only.txt` is credited `[B]` with actor Bob, `shared.txt` `[B, C]`, and `carol-after.txt` `[C]` with actor Carol; B and C exited 0 |
| `readsTakenIn` | the reads are the boot view's; its read set and Alice's run hold `p4/seed.md`; Alice's run's take-in answered for the view; SQL has Bob's run as another agent's (not the view's), with the company audience and its agent and member reading the root; Bob's run held no read before, its take-in answered for the view with reads (not a replay), and its reads after are exactly the view's. A refusal fails the check |
| `vsockPorts` | the guest's probe exited 0, scanned 65535 ports of CID 2, and none timed out; every port that did not answer ended in `ECONNRESET` or `ECONNREFUSED`, any other errno fails, and the answers plus the refusals are the 65535 scanned; 5250 answered, held by this run's bridge; every other port that answered has an allowed owner: one LXD port (the lxd daemon, bound to CID 2, any port number), 22 (systemd's `sshd-vsock.socket`) and 8443 (`lxd-agent`) only when `systemd-detect-virt` says VM. Any other port, another owner or no owner fails. The record lists each answering port with its owner, its bound CID and the `systemd-detect-virt` value |
| `detached` | `p4/detached.txt` is committed after SQL had its command's end, after its window closed and after the go, with no command running or with a window open; the commit and its unit credit no command; the actor is Alice's staff agent with the boot view's run (Alice's run) and the owner, from that `test_machine` view |
| `loop` | the guest's clock was measured; L printed at least four ticks in order and its last change on TERM (one more); each tick's own bytes were saved (a commit with a `seq`, its unit saved as a version with that tick's `file_sha256`) within 10 s and not before the write, so a refused or conflicting attempt or a later save never counts for a tick; with no boundary asked in the quiet window, at least two ticks there were saved by the quiet publish (a `seq` no boundary or window close reported) 1.5 s to 8 s after they were made; every commit of `loop.txt` credits `[L]`; the read's boundary `seq` is the first save of a tick, and the cancel's boundary `seq` saved L's last bytes; L ended `cancelled` |
| `stopClosed` | the stop's outcome is `done`, the final boundary named the view, `restarted` was answered, SQL has the view closed and LXD has the VM stopped |
| `stopWhileRunning` | S's last line (written on TERM) is read on the second boot; the final boundary's publish saved `stop-loop.txt` within the quiet period (plus the clock's uncertainty) after S wrote it, and answered before the LXD stop request |
| `secondBoot` | the second start mounted with a new boot id and a new view id, and its command reads the files |
| `endedRefused` | K is `lost` with an end time; its start sent again is refused `MACHINE_COMMAND_ENDED`; `k.txt`'s unit is answered `command_ended` (its first answer after K ended that is not `waiting`: a boundary while K's bytes are still on their way says `waiting`) and `k.txt` is not in the folder; `m.txt` is committed credited `[M]` |
| `otherMachineRefused` | the hand-over was of the second boot's view; the service saw the second VM's opens of that view, found the VM, and refused every one `VIEW_REFUSED`; the guest answered `closed` for that view; and the real machine reads afterwards. `unanswered`, `UNAVAILABLE`, `BUSY` or an open of another view fails the check |
| `noRootRead` | grants were revoked and SQL says Bob's agent does not read the root; the outcome is `FOLDER_NONE:REFUSED`; SQL refused the open 42501 "Folder view needs the company-wide view" without the new-disk detail; no view of the machine; the placement is marked unchecked; the look found no `/company` mount and 0 entries; its start and receipt say `company: none` with the refusal's `why` |
| `reverse` | the unit and its marker were installed; the grants were given back and SQL says Bob's agent reads the root; the stop was `done`; the next open was refused "used without the folder check" with the new-disk detail; the old placement is retired (`FOLDER_RETIRED:UNCHECKED`, reason `unchecked`); the machine mounted on a new v2 placement, where the look found `/company` with the seed, no unit and no marker, and its receipt says `mounted` |
| `narrowed` | `p4-narrow` mounted and Alice's read said `mounted`; Carol's grants were revoked and SQL says her agent does not read the root; Carol's new command, read and cancel were refused, with at least three 42501 "Machine needs the company-wide view" from SQL, and her command has no receipt; Alice's read was answered; the host restarted for the closed view; Alice's read of the ended boot says `none` with the host's `why` and `heldBack`; the old placement is retired (`FOLDER_RETIRED:STARTER`, reason `starter`) after an open refused with the new-disk detail; the grants were given back and the machine mounted on a new placement; `a-long` is `lost` (`restart_view_closed` or `moved_starter`), and Alice's read of it is refused `MACHINE_COMMAND_ENDED` with that `folderLost` and `lost` words (the host's for a restart); the new disk has `/company` |
| `serviceClean` | no step raised, no host pass failed or threw, no SQL call deadlocked (the executor's, the folder core's, the object authority's or the keeper's; each deadlock is listed in `deadlocks` with its time, the function called, the PL/pgSQL functions it was raised in, the SQLSTATE, both waits and the row lock it was taking), every cleanup closed, and the folder bridge did not exit on its own (the host waits up to 900 s for a nested guest to answer; see "Stood in") |
| `noSecretsInEvidence` | no holder token, view pass (of either boot) or service token of the run appears in the record (the record the wrapper prints) |

## Stood in

- **The image.** The reviewed image is built by
  `deploy/machine/build-machine-image.sh` in a node's build space, on its
  network. The claimed project has no network, and the proof makes no host link,
  so the stand-in is `ubuntu:26.04` with no NIC, the test machine's Node binary
  as `/usr/bin/node`, 6c's guest package (the helper, the slice, the watchdog
  units, the folder program and its unit) pushed in at the image's paths,
  `/company` made, and the watchdog timer enabled. Docker, fuse3, the toolbox
  and apt's masks are not in it. The image's bootstrap sha is that of the
  wrapper and the guest package's manifest.
- **The NIC and the plug.** A machine's only card is on the agents' bridge
  (`qagent0`), plugged by the agent exit. The proof makes no host network, so a
  wrapper around the LXD client takes the device `network` out of the create
  request and puts it back into the devices `getInstance` answers, so the host's
  own instance check holds; the agent plug answers a fixed MAC
  (`0e:51:0a:d2:01:0a`). The VM runs with no NIC.
- **The NAS.** The host's journal sits under a coding NAS mount. The proof's
  bundle replaces `coding-storage.ts`'s `createCodingNasStorage`, for the host
  only, with one whose control path is a 0700 folder of the work directory and
  that mounts and checks nothing. The NAS policy names a documentation address
  (`192.0.2.1`). The object store is a local folder too.
- **PostgREST.** The executor's control, the object authority and the folder
  core speak PostgREST. Their fetch and transport turn each
  `/rest/v1/rpc/<name>` call into one psql session in the throwaway database:
  as its superuser, with `request.jwt.claims` set to the `service_role` claims,
  it selects `to_jsonb(public.<name>(...))` with the body's named arguments.
  Errors are read from psql's verbose output: the SQLSTATE gives the status
  (`postgrestStatus`, after the folder core acceptance) and the `DETAIL` the
  details (the executor reads a view open's refusal from it). The folder clocks'
  read is served the same way. The keys are the fixed string `p4-stand-in`.
- **The executor.** The command service, the router (no peers) and the host run
  in the harness's process, not in the executor's service; the pass loop runs
  every 2 s (the executor's every 10 s). The machine provider is 628's
  `machine-fixture`, enrolled on a node of the fixture's own.
- **The guest's ready wait.** The host is given `guestReadyTimeoutMs: 900_000`
  (its default is 180 s), as P3's executor test is. Nested VMs on the loaded
  test machine took 182–234 s to answer in run 1, so the default failed their
  starts (`LXD_INSTANCE_FILE_UNCONFIRMED`) a few passes before each one came up.
  A guest still starting stays `pending`; any failed pass still fails
  `serviceClean`.
- **The folder service and bridge.** The service runs in the harness's process
  (`start()`: its poll, heartbeat and renewal timers), not under its systemd
  units; its control socket is root's (mode 0600), and the executor is uid 0.
  The folder program's bridge runs as root from the work directory, with the
  real LXD socket for its machine lookups.
- **The keeper.** No runner heartbeats in the proof, so every 20 s a loop renews
  each run's job lease and native provider lease, rotates each runner's session
  every 5 minutes (`qorpera_heartbeat_runner`), and refreshes the node's
  inventory observation in two transactions, as the real observer's two calls
  do: `qorpera_runtime_node_inventory_context`, then `p4.mc_observe_with`
  (628's `mc_observe`, naming the claimed project, made to take that context as
  a parameter). 628's `mc_observe` does both in one transaction, which holds
  the node before an allocation, the reverse of the host's reserve; in run 1 it
  deadlocked (40P01) with `qorpera_authorize_executor_machine`.
- **The runtime's receipts.** The proof calls the gateway as the runtime's
  `machine_run` does, but begins and completes each receipt itself
  (`qorpera_describe_native_tool_authority`,
  `qorpera_begin_native_tool_operation`,
  `qorpera_complete_native_tool_operation`), with the operation sha the
  executor recomputes and a fixed downstream sha (`'5' * 64`). Machine starts
  and the stop are SQL calls as Alice's run (628's `mc_start`,
  `qorpera_native_machine_manage`), not a model's tool calls.
- **The fixture's lease tokens.** 924 gives every run the lease sha
  `repeat('3', 64)`. The proof gives each run a random token and puts its sha in
  the fixture instead, so the holder (`job.<jobId>.<token>`) proves only that
  run.
- **The held boundary.** To show that output waits for `released`, the folder
  control the host is given answers every boundary and window close as
  unanswered (`FOLDER_CONTROL_UNANSWERED`) for the 10 s after A's start. Every
  other request goes to the service.
- **K's end.** K is ended with SQL's own end for stopped commands
  (`qorpera_end_company_machine_commands(..., 'stopped', [K])`), the one the stop
  path uses, while the guest still runs it.
- **The take-in.** The host takes in a run's reads at each read of its output
  (6d-3b): Alice's from step 1, Bob's and Carol's in step 4. Bob's run has read
  no output by step 3, so the proof calls `qorpera_folder_run_inherit_view_reads`
  itself for his run there, and once more for Alice's.
- **The second machine.** It is made with the `lxc` CLI in the claimed project,
  not by the host, and prepared through the guest helper.
- **The seed.** `p4/seed.md` is staged with the platform writer, so its bytes
  are in the object store the service reads, and committed as the owner.
- **The root read.** Steps 10 to 12 take an agent's root read away by setting
  `revoked_at` on its `qorpera_company_path_grants` rows, in replica mode, as
  SQL test 516 does, and give back only the rows revoked then. No member or
  owner changes a grant through the product.
- **The paused passes.** The proof pauses the host's pass loop for L's quiet
  window and the reads and cancel after it, and after the narrowed machine's
  restart and retirement outcomes, so each state can be read before the next
  pass moves on. A paused pass waits; it is not skipped.
- **The detached writer's go.** `/run/p4-go` is created by the proof with
  `lxc exec`, not by an agent's command, so no window opens for it.
- **The guest's clock.** L's and S's times are the guest's; the proof places
  them on its own clock from the fastest of five `lxc exec date` calls, within
  half that call's time (plus 50 ms in the checks).
- **The vsock probe.** It runs with the image's `python3`.

Tokens, holders and view passes are made per run, held in memory and never
printed. Each view pass is added to the run's secrets the moment its hand-over
is seen, before the guest is asked, so every boot's pass is looked for, in a
run that fails early too. `noSecretsInEvidence` checks the record for every one
of them, and the record is written with them redacted if one slipped in.

## Limitations

- The VM has no network: a networked command (the networked `curl`), the
  agents' bridge and the agent exit are not exercised. The networked curl, the
  web app view of a test machine and Docker (the stand-in image has none) are
  C8's (rows C3-2 and C3-7), not 6f's.
- Everything a model drives stays deferred (needs Codex), as the plan says
  (`RUNTIME-FOLDER-TEST-MACHINES.md`, lines 506 to 508): the automatic review
  judging a `machine_run`, an agent woken by `notify` with its saves listed, a
  worker waiting on a command, and README's acceptance step 4.
- The real-node vsock scan is C8. From a test machine on a real node host, the
  guest reaches exactly 5250 plus the one CID-2 port the host's
  `ss -l --vsock` shows (LXD's own listener).
- On the shared test machines, nested VMs can reach the test machine's own
  sshd over vsock (port 22; key login still applies). That is a limit of
  running the proof nested, and nothing changes on the test machines.
- One node, one executor: routing to a peer executor is not exercised.
- The folder service runs in the harness's process, not under its systemd
  units and sockets.
- No model: the runs' calls are made by the harness, as the runtime would.
- Bob's step 3 take-in is a SQL call; his run reads output only in step 4,
  where the host takes his reads in, as it does Carol's. The notify
  continuation's take-in (6d-3c, `20260930500000`) is a SQL path, tested
  in SQL test 519, not here.
