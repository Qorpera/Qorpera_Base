# Test machine folder proof

This is P4 for F3 step 6 in
[`RUNTIME-FOLDER-TEST-MACHINES.md`](../first-node/RUNTIME-FOLDER-TEST-MACHINES.md):
an agent's test machine works with the company folder, end to end. A command an
agent runs on its machine reads and writes `/company`, what it changed is
committed under that command's credit, and its output reaches the caller only
after a boundary answers `released`. It is not an image release, a node rollout
or live-company acceptance.

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
`TEST_MACHINE_FOLDER_EVIDENCE_BEGIN` and `TEST_MACHINE_FOLDER_EVIDENCE_END` and
fails the run if the test machine changed: its links, nft tables, forwarding
and conntrack sysctls, `br_netfilter`, and its kernel modules (none gone; no
bridge, tun, macvtap, vhost, vsock or fuse module new). The guest loads FUSE
only inside the nested VM, and only if `/dev/fuse` is missing.

## The steps

Each step's evidence is in the record under its name. They run in the order
below; the reads come before the overlap, so Bob's run has had no command on the
machine when it takes the reads in.

1. **`boot`.** Alice's run starts machine `p4` (`machine_start` through 628's
   `mc_start`, which makes and checks the tool's receipt). The host's pass admits
   it, creates and starts the VM, marks the boot running, opens the boot's
   `test_machine` view and hands it to the guest, whose `folder-mount` mounts
   `/company` (the outcome `FOLDER_MOUNTED`). A command of Alice's lists
   `/company` and reads the seeded `p4/seed.md`.
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
   while her commands ran. 6d-3's output path is not built, so the take-in a
   run's read of a command's output would make is called in SQL:
   `qorpera_folder_run_inherit_view_reads` for Alice's run (her machine's view),
   then for Bob's run, whose agent's view it is not. 6a-3 lets a run with the
   company audience whose agent and member read the root take it in, and refuses
   any other with 42501 ("only with the company-wide view"). The record keeps
   Bob's read rows before and after.
4. **`overlap`.** Bob's run starts B, which writes `bob-only.txt`, then after 6 s
   appends to `shared.txt`. Carol's run starts C 3 s after B, which appends to
   `shared.txt` within a second and writes `carol-after.txt` 24 s later, after B
   has ended. Credits are per unit, by the windows open when the change was
   made: `bob-only.txt` `[B]` under Bob, `shared.txt` `[B, C]`, and
   `carol-after.txt` `[C]` under Carol.
5. **`refusals`.**
   - Carol's command M writes `m.txt`, which is committed credited `[M]`.
   - Bob's command K sleeps 5 s, then writes `k.txt`. Right after its start
     returns, SQL ends K (`qorpera_end_company_machine_commands(machine,
     'stopped', [K])`, which sets it `lost`). The service keeps K's window open
     until the guest says K ended, so the write is credited to K; its publish
     (after the quiet period, or at the boundary of a read of M 8 s later) gets
     `k.txt` refused `command_ended`, and `k.txt` is not in the folder. K's
     start sent again gets `MACHINE_COMMAND_ENDED`.
   - SQL ends a command, not a run: a run's end alone does not end its commands,
     so their changes are still credited (the commit's run is then null). The
     brief's "a command whose run ended" is shown with the command's own end.
   - A second VM in the project, named like a machine
     (`qorpera-machine-<random>`) and made from the same image, is prepared
     through its own helper, then given the hand-over the host gave the real guest
     (its `folder-mount` stdin, kept in memory, never logged). The service
     refuses its open: its instance is not the view's placement. The real
     machine's next command still reads `/company`.
6. **`stop`.** Alice's run stops `p4` (`qorpera_native_machine_manage`,
   `stop`). The host's stop runs a boundary and then the final boundary with
   the view, powers the VM off and sends `restarted` for the machine; SQL has
   the view closed. Alice's run then starts `p4` again: a new boot, a new view,
   and `/company` reads the files the first boot wrote.

## What the JSON establishes

`result` is `passed` only if every check below passed.

| Check | Passes when |
|---|---|
| `bootMounted` | the host's pass reported `FOLDER_MOUNTED`; SQL has the boot's `test_machine` view open; the first command succeeded and printed the seed |
| `heldUntilReleased` | while held, a gateway read of A got `running`, empty output and a null exit code, and boundaries were asked; the read after the hold got A's output and exit 0, after a boundary answered `released` |
| `creditedToCommand` | `p4/alice.txt` is committed with credits `[A]`, actor `staff_agent` Alice, run R and requester the owner, from the `test_machine` view |
| `overlapCredited` | `bob-only.txt` is credited `[B]` with actor Bob, `shared.txt` `[B, C]`, and `carol-after.txt` `[C]` with actor Carol; B and C exited 0 |
| `readsTakenIn` | the view's read set and Alice's run hold `p4/seed.md`; Alice's run's take-in answered for the view; Bob's run held no read before, and either took them in or was refused as a run without the company-wide view, its reads unchanged |
| `endedRefused` | K is `lost` with an end time; its start sent again is refused `MACHINE_COMMAND_ENDED`; `k.txt`'s unit is answered `command_ended` and `k.txt` is not in the folder; `m.txt` is committed credited `[M]` |
| `otherMachineRefused` | the second VM's mount is not `mounted`, the service saw its open and refused every one, and the real machine reads afterwards |
| `stopClosed` | the stop's outcome is `done`, the final boundary named the view, `restarted` was answered, SQL has the view closed and LXD has the VM stopped |
| `secondBoot` | the second start mounted with a new boot id and a new view id, and its command reads the files |
| `serviceClean` | no step raised, every cleanup closed, and the folder bridge did not exit on its own |
| `noSecretsInEvidence` | no holder token, view pass or service token of the run appears in the record (the record the wrapper prints) |

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
- **The folder service and bridge.** The service runs in the harness's process
  (`start()`: its poll, heartbeat and renewal timers), not under its systemd
  units; its control socket is root's (mode 0600), and the executor is uid 0.
  The folder program's bridge runs as root from the work directory, with the
  real LXD socket for its machine lookups.
- **The keeper.** No runner heartbeats in the proof, so every 20 s a loop renews
  each run's job lease and native provider lease, rotates each runner's session
  every 5 minutes (`qorpera_heartbeat_runner`), and refreshes the node's
  inventory observation (628's `mc_observe`, naming the claimed project).
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
- **The take-in.** 6d-3's output read is not built; the proof calls
  `qorpera_folder_run_inherit_view_reads` itself (step 3).
- **The second machine.** It is made with the `lxc` CLI in the claimed project,
  not by the host, and prepared through the guest helper.
- **The seed.** `p4/seed.md` is staged with the platform writer, so its bytes
  are in the object store the service reads, and committed as the owner.

Tokens, holders and view passes are made per run, held in memory and never
printed. `noSecretsInEvidence` checks the record for every one of them, and the
record is written with them redacted if one slipped in.

## Limitations

- The VM has no network: a networked command, the agents' bridge and the
  agent exit are not exercised.
- One node, one executor: routing to a peer executor is not exercised.
- The folder service runs in the harness's process, not under its systemd
  units and sockets.
- No model: the runs' calls are made by the harness, as the runtime would.
- The take-in is a SQL call; the output path that makes it (6d-3) is not built.
