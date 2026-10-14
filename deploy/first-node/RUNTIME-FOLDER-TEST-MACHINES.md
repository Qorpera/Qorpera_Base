# Test machines on the folder (F3 step 6): the plan

Status: plan, for review before it is built. No slice is built yet.
Test machines are today's company machines ([deploy/machine/README.md](../machine/README.md): the `machine_*` tools,
`qorpera_company_machines`, the guest helper). The design calls them test machines, and so does this page. The design it
follows is [RUNTIME-COMPANY-FOLDER.md](RUNTIME-COMPANY-FOLDER.md)'s 14 October decision ("Which view each machine gets":
the test machine paragraphs; "What a crash loses"; "Nothing on a node"; build order row 6), with §2 ("When changes are
published") and §8 (what a test machine reaches), and the contract's 2026-10-14 amendment ("machines work in the folder
as on their own disk": item 1 the bar, item 2 commands as root, item 3 programs that keep running, items 4–6 links and
special files, item 7 the toolbox, item 8 the machine's own cache, item 10 until a machine carries the folder). The views
are C1b-3's ([RUNTIME-COMPANY-FOLDER-C1B.md](RUNTIME-COMPANY-FOLDER-C1B.md) §1–§7, and §8 "C1b-3b: shell commands and
test machines"). It reuses step 4's mechanics ([RUNTIME-FOLDER-COMPANY-MACHINES.md](RUNTIME-FOLDER-COMPANY-MACHINES.md):
the serving check, the boundary answer, the reasons, the mount propagation proof) and step 5's
([RUNTIME-FOLDER-CODING-MACHINES.md](RUNTIME-FOLDER-CODING-MACHINES.md): the in-memory read record, release fan-out, the
host-local control socket, machine-wide boundaries and `served_by`). Where this page differs from them, it says so and
why. Facts about today's test machines are from master at 63f697118.

## What step 6 delivers

A test machine whose starter's authority covers the company-wide view works in the company folder at `/company`. Its
commands read and write the company's files as on their own disk (item 1), with the network and the folder (item 2). A
program that keeps running publishes about two seconds after its last change, each time its output is read, and when it
ends (item 3). Each save is credited to the commands that ran while it was made, from #419's command records on the
node. Once `/company` is mounted, starting a command passes the automatic review as an outside effect (design: "a
worker's commands pass under its agent's rules"). The read-only repository disk at `/mnt/repository`, and the copy of it
to the machine's own disk, retire (build order row 6).

What does not change: a test machine is the company's own scratch compute, any agent of the company may use it, and every
member sees it. Its only network is the agent exit: it reaches the internet but no private network, the NAS, the nodes or
the control plane (§8). Its disk is throwaway ("Nothing on a node"). Its dependencies and builds stay in its own cache and
are never published (item 8). A machine whose starter's authority does not cover the company-wide view has no `/company`
and works as today (item 10; review of its commands is Q2).

**Root is the agent's.** On a test machine an agent is root (design: "The guard there is the CID check plus exactly one
view per machine"). Root reaches every command on the machine, whichever agent started it. So the walls between commands
keep order, not security: crediting a save to its commands is best effort, and "it can misname the saver, never widen the
view". What any command can see or change is the one view's, which is the starter's (below), and each save must also be
allowed for every agent it is credited to (C1b §8). Nothing that must hold for the platform, for another company or
for an agent's authority runs inside the machine: the folder's checks, the read record, receipts and the lease stay
outside it (below).

## The parts

- **The test machine**: one LXD VM per placement, `qorpera-machine-<placementId hex>` in the LXD project `machines`
  (`lxdCompanyMachineName`). Its only NIC is on the agent plug (`agentPlugCard("eth0")`), so all its traffic leaves
  through the agent exit. Its disk is scratch.
- **The guest helper** (`packages/runtime/src/cloud-machine-guest.ts`, today's): runs as root in the VM and is
  untrusted. It runs each command as a transient systemd unit under `qorpera-machine.slice` (`KillMode=control-group`, as
  today) and, new in 6c, starts and restarts the folder program. The executor drives it only by LXD exec; its answers are
  observations, and the executor's journal and SQL are the truth.
- **The folder program**: step 1's FUSE program, one per machine, as root in the VM, at `/company`.
- **The node's folder service** (`packages/object-gateway/src/folder-service/`): serves the machine's one view to that
  machine only, records each read it serves, tags each change with the commands that ran when it was made, publishes and
  answers boundaries.
- **The executor** (`packages/runner-orchestrator/src/company-machine-host.ts`, and the command route
  `cloud-machine-command-http.ts`): opens the view for each boot, hands the folder program its pass, tells the folder
  service when each command starts and ends over the host-local control socket (5c), and asks for a boundary before any
  answer that carries the machine's output.
- **SQL** (6a): the `test_machine` view kind, credits per unit in a publish, the machine's read set, and the check that a
  caller may use a machine that has `/company`.
- **The review** (6d): `cloudActionEffect` (`packages/runtime/src/cloud-action-review.ts`) classes `machine_run` as an
  outside effect.

## What stays outside the machine

Root in the VM can't be trusted for anything that must hold beyond the machine itself. Everything below runs on the node
host or in the core, and the VM sees only its results.

| What | Where it runs | Why it can't be in the VM |
| --- | --- | --- |
| The folder's checks: authority, the view, names, sizes, links and special files (items 4–6) | The node's folder service and the core | Root can change any program in the VM. |
| The read record and release | The folder service records each read it serves, in memory, before the answer leaves (5c) | A guest-kept read log could be edited. |
| Command windows and credit | The executor tells the folder service when each command starts and ends; the service tags each change with the commands open at that moment | The guest can lie about which command made a change. |
| Receipts and the output tail | The executor writes them through SQL, as today (`qorpera_record_company_machine_commands`) | They are history; root can rewrite anything on the machine's disk. |
| Whether the view is still valid | SQL, at each renew, release and commit: the boot and placement are the view's, and the starter still reads the root | The folder program renews the lease (C1b-3 §5), and root can keep that up; the lease is not what keeps the view valid. |
| The pass | Handed to the guest over exec stdin only, never into LXD config, `user.*` keys, cloud-init or a host file | Root reads every file, environment and LXD key in the VM. |

## The security line

**What an agent's root reaches.** Its own VM: every command, file, process and mount on it, whichever agent started them.
The folder only through the one view served to that VM, so never more than the company-wide view as the starter's
authority allows it (below). The network only through the agent exit, under company rules, with our own networks refused
(agent exit §3) and the exit's port isolation between guests. One host service on vsock: the folder service, whose
bridge asks LXD which instance has the caller's CID and serves only that instance's view
(`packages/object-gateway/src/folder-service/machines.ts`). LXD's own agent channel, which runs only what the host
starts.

**What it can't reach:**

- **Other companies.** A machine belongs to one company and environment, its view is that company's, and the exit's
  company rules and log are per company. A pass read on one VM fails on any other: the service serves a view only to
  the instance it names.
- **The node host.** The VM is a KVM guest. The host listens to it only on the CID-checked folder service; every stream
  into the VM (the guest helper's calls, the folder program's start) is started by the host. `security.devlxd=false` on
  test machines (new in 6c, as step 5 does for coding machines), so `/dev/lxd` offers the guest nothing.
- **Platform keys.** A test machine holds no credential (README). No service-role key in the guest (G2). No secret or
  pass goes into LXD config, `user.*` keys or cloud-init.
- **Our networks.** The NAS, the nodes, private networks and the control plane: the agent exit refuses them (§8).

**What never changes on node hosts.** No kernel modules, sysctls or nft changes; the agent exit and the guest guard are
unchanged. Test machines stay in the `machines` project; nothing is created in a node host's own LXD outside it. A proof
that needs any of this runs only inside a throwaway nested VM.

**Root inside the VM is accepted, not walled.** Item 2: where commands run as root, "a namespace does not hold a
command. There, every command has the network and the folder". So step 6 adds no wall between commands inside the VM.

## Views and machines

**When `/company` is mounted.** The design: "`/company` is mounted only when the starter's authority covers the
company-wide view. Its one view is opened by the starter's run, holds the lease and sets what can be seen." The starter
is the machine's `started_by_staff_agent_id` and the member it acted for, `requested_by_user_id`
(`20260928259050_runtime_company_machines.sql:123–129`). Its authority covers the company-wide view when both the agent
and the member read the company folder's root now. The test is made at each boot, so a starter whose authority widens
gets `/company` at the machine's next boot, and one whose authority narrows loses it (renew, below).

**The view.** Each boot that passes has one open `test_machine` view (C1b-3 §1: "one open view … per test machine";
the partial unique index on `(company_machine_id) where state='open'`, new in 6a). The executor opens it right after
`qorpera_mark_company_machine_running` records the boot, in its own transaction (C1b-3 §5), with the opener
`{"kind":"platform"}` and the anchor `{companyMachineId, placementId, bootId}`. The open takes the machine fence
(`qorpera_folder_machine_fence`), then the machine row and its current placement `FOR SHARE` (C1b-3 §3's `test_machine`
row: "the placement and `boot_id` are the view's"). The view's `machine_id` is the placement's id, which names the
instance (`qorpera-machine-<placementId hex>`). The view names the starter's agent and member, and its run is the
starter's run (`started_by_run_id`) for credit and inheritance. It shows the company-wide view (`companyWide` true, as
for `computer_desktop`), as the starter's agent and member may see and change it. The executor hands
`{environmentId, viewId, pass}` to the guest helper over exec stdin before it starts any command of that boot.

The design has the starter's run open the view. Here the executor opens it on that run's behalf, as the office opens a
desktop's view: a boot often comes long after that run ended (a member's Start, or another agent's wake), and only the
executor knows when the boot is up. The view still names the starter and its run (amended below).

- **A refused open** leaves the boot without `/company`: the machine runs as today (item 10), and the report says why
  (the starter's authority, the machine stopping). The next boot asks again.
- **An open with no answer** (the core unreachable) is retried at every executor pass. A command started before the
  boot's open is answered waits for it; with no answer by the start's deadline, the start fails as unreachable, the way
  a start fails today when the guest does not answer.
- **Renew and close** are the folder program's, as on every machine (C1b-3 §5): renew extends the lease by 120 s and
  closes the view `ended` or `expired` once it is no longer valid. A `test_machine` view is valid while its placement
  is not removed, the machine's `boot_id` is the view's, and the starter's agent and member still read the root (6a, in
  `qorpera_folder_view_valid`). A retired placement stays valid, so a delete's final boundary can still publish (below).
  The executor closes the view after the final boundary at stop, sleep, delete, suspend and release (C1b §8: the end
  boundary keeps the view valid for one final publish with `final`, and the commit closes it).
- **A starter whose authority narrows** makes the next renew close the view `ended`. What was not yet published is not
  applied, and the commands running are told why. The executor sees the closed view at its next pass and restarts the
  VM, so no command keeps running under a view that is gone, and the next boot's open decides again.

**Serving.** As step 4's 4a and step 5's 5c, the view's first renewal says its kind and machine, and the service checks
the calling VM's CID (`{project, name, physicalId}` from LXD):

- a `test_machine` view is served only to `qorpera-machine-<machine_id hex>` in one of the node's `testMachineProjects`
  (new in 6b, as step 4's `companyMachineProjects`; on our nodes the `machines` project), read-write, with a quiet
  publish about 2 s after its last change (item 3);
- no other machine gets it, and a test machine gets no other kind; a kind or machine that changes closes the view (as
  4a).

**Access.** Any agent whose authority covers the view may run commands there (design). So while the machine's current
placement has an open `test_machine` view, or had one this boot, `qorpera_authorize_machine_command` (start, read and
cancel) also requires the caller's agent and member to read the root now (6a). A worker is checked as its agent.

**The service that served a view** is named on it (`served_by`, 5a's), and a view served by a crashed service is
refused (5a), as for coding views.

## Mounts in the VM

The guest helper starts one folder program, as root, at `/company`, with `allow_other`, from the pass it read on exec
stdin. The pass stays in the program's memory and is never written to the disk. The helper restarts the program if it
exits while the boot's view is open; root can stop or unmount it, which changes nothing outside the machine. There is
one mount for the whole machine and no namespace per command (item 2): every command, and every process a command leaves
running, sees the same `/company`. A Docker container binds `/company` like any other path; 6c's tests repeat step 4's
mount propagation proof for a container started before the mount came up.

- **Commands.** Each command runs as today: a transient systemd unit under `qorpera-machine.slice`, with
  `KillMode=control-group` (`cloud-machine-guest.ts:459`). A program that keeps running, such as a dev server or a
  watcher, is a command that has not ended. What a command leaves behind outside its unit (a Docker container, a timer)
  keeps running, and its changes made while no command runs are credited to the starter ("Commands and credit").
- **Links and special files** (items 4–6) are the folder program's and the service's, from the links slices (step 4's
  links lane), so a test machine gets them with the program.
- **Item 8's caches** stay on the machine's disk: "The folder program keeps item 8's caches on the machine." Step 6
  uses that part of the program as whichever slice builds it first leaves it ("whichever of it and 5d lands first
  builds the program's part"). 6e, which retires the copy to the machine's disk, waits for it.
- **The toolbox** (item 7): "Agents' own machines and test machines start from a base image that carries it." 6c adds
  to `build-machine-image.sh` what today's image lacks of 4e's list (`tsc` and `tsx`, uv, ripgrep, fd, sqlite3, zip and
  LibreOffice), with `fuse3` and the folder program, in a new image generation. The image tests are 4e's: every
  toolbox command answers `--version`.

## Commands and credit

**Command windows.** Credit comes from #419's command records on the node: the command rows that
`qorpera_authorize_machine_command` writes (machine, placement, run, agent, requester) and the executor's journal of
when each one runs. The executor tells the folder service over the host-local control socket (5c) when a command's
window opens and closes, with `{commandId, runId, staffAgentId, requestedByUserId}`. It opens the window after the
command row is written and before the guest starts the command. It closes the window once the guest reports that the
command ended (its unit's processes are gone then, `KillMode=control-group`), and right away asks for the command's end
boundary (below). The service tags each pending change with the commands whose windows were open when it was made. A
change made while no window is open is tagged with the starter.

**When the service publishes** (design §2, item 3):

- about 2 s after the machine's last change: item 3's quiet publish applies here (decided), since a program that keeps
  running is common on a test machine and may never end or be read;
- at each read of a running command's output, before the answer leaves (a boundary, below);
- at each command's end (its end boundary);
- at stop, sleep, suspend, release and delete (the final boundary).

**Credit per unit** (6a). Each unit of a publish carries `credits`: the commands its changes were tagged with, or none
for a change made while no command ran. SQL checks each credited command against `qorpera_company_machine_commands`:
that machine, that placement, not ended, where a publish made at that command's own end counts (C1b §8). A unit whose
credited command fails the check is refused alone, as an outcome ("its command ended before it was published"),
since only malformed requests raise. Each unit must be allowed for every credited command's agent and requester, and a
unit with no command for the starter's. The commit's actor is the credited command that started first, and its
`credits` lists all of them (C1b §8). When commands overlap, each of their receipts lists the others (design).

C1b §8 names the commands once per publish. Step 6 names them per unit, because one publish often holds a change
made under one command next to a change made while two ran. Crediting every unit to both would refuse the first unit
whenever the second command's agent may not change it, and would misname its saver. Per-unit credits keep the design's
rule ("it can misname the saver, never widen the view") as close as the windows allow (amended below).

**Changes made while no command runs** (a Docker container, a program a command left outside its unit, root's
timers) go to the starter "at the next publish or at stop" (design).

**The end order.** The executor records a command's end, and its output tail, only after the command's end boundary
is answered. So every change tagged with that command is published while SQL still sees it running, and the notify
continuation and a worker's read see the tail only after the command's changes are saved or refused. At stop, sleep,
suspend, release and delete, the executor runs the final boundary with the VM still up, before the power-off. The
commands then end with the stop's cause, as today, and a delete's commands end only at close, after the release
("The machines' end paths need no change", C1b §8).

**A guest reboot.** A new `boot_id` ends the old boot's commands `lost` (`qorpera_mark_company_machine_running`). The
service still holds what was pending, so the executor first runs the final boundary on the old view, which is still
valid because SQL still has the old `boot_id`. Then it records the new boot and opens the new boot's view.

**A lost machine.** When the VM, the node or the folder service dies, what was pending since the last boundary is lost
(founder decision 3, "What a crash loses"). The commands end `lost` as today, and their receipts say "not applied: the
machine was lost".

## Review

The design: "Once `/company` is mounted on it, starting a command and typing into one are outside effects and pass the
automatic review…; a worker's commands pass under its agent's rules… Until then a machine has no company folder and its
commands are not reviewed." Today every machine tool is "internal" or "read" (`cloud-action-review.ts:226–233`: "A
company machine is the company's own scratch compute").

- **From 6d, `machine_run` is "external"**, as `computer_shell`'s commands are ("A command can reach the internet, and
  so can what is typed into one"). With `/company` mounted, a command also reaches the company's files (item 2).
- `machine_read` and `machine_list` stay "read". `machine_start`, `machine_cancel`, `machine_stop` and
  `machine_delete` stay "internal": starting a machine runs nothing of the agent's, and the others only end work.
- No tool types into a running command today. One added later is "external" too (the design's "typing into one").
- **A worker's commands** pass under its agent's rules (design). 6d's tests show a worker's `machine_run` reaching the
  review with its agent's rules, and 6d adds that where it does not.
- **A boot without `/company`.** Read with item 10, the design leaves such a machine's commands unreviewed. This plan
  reviews every `machine_run` instead (Q2), for three reasons. `cloudActionEffect` is a pure function of the tool and
  its arguments, and whether a machine has `/company` is decided per boot, so it can change between the review and the
  start. A machine's disk may still hold copies of company files from an earlier boot that had `/company`. And a
  folderless machine is still a networked command run on the company's behalf. If the coordinator keeps the design's
  reading, 6d instead classes the call from the machine's state at the call, and `qorpera_authorize_machine_command`
  refuses an unreviewed start on a boot that has a view.

## Reads

Today a test machine has no view and records no reads. With root, one command can read through `/company` for
another, so a read can't be pinned to one command. The design: reads go "in the read set of every run with a command
running at the time. Reads made while none runs are recorded on the starter's view", and "the next run inherits"
them. Step 6 builds that as follows:

1. **Recording and release.** The folder service records each read it serves under a `test_machine` view, in memory,
   before the answer leaves the service (5c); nothing the guest reports about reads counts. Each read reaches the view's
   read set and every run with a command running on the machine at the time whose job is leased, before any output of
   the machine reaches a model and before any save of the machine commits: the service releases the machine's recorded
   reads before each of its commits, quiet publishes included. Not followed: a copy on the machine's disk of a read that
   never reached a model or a save (C1b-3 §6: "it does not trace every copy").
2. **The view's read set lives with the disk.** It holds every read of the machine, those made while no command ran
   included, and carries to the next view of the same placement (a reboot or a wake on the same disk). A new placement
   starts clean, because it has a new disk.
3. **Output takes in the view's reads.** Every path that hands machine output to a run first takes the view's read set
   into that run (`qorpera_folder_run_inherit_view_reads`): the receipts of `machine_run`, `machine_read` and
   `machine_cancel`, the notify continuation and a worker's read. Output can show what any command on the machine read,
   so whoever sees it takes in what the machine read. This also covers a run whose command ran while its job was not
   leased (rule 1 reaches only leased jobs).
4. **Boundaries come after reads.** A boundary (below) is answered only after every recorded read of the machine is
   released. A boundary with no answer holds the output back: the model gets nothing from the machine until it is
   answered.
5. **What can't be proven is refused.**
   - **A crashed service.** A view whose `served_by` is still set by a service that did not stop cleanly may have
     served reads that were never released. Every `test_machine` view that service served is refused, the VM is
     restarted and the next boot opens a new view. The read set keeps what was released.
   - **`unreadable`** (a released read the core can no longer place, or a take-in that raises "A read is no longer
     readable") holds the output back, and the executor retires the placement, so the machine starts on a new disk at
     its next start.
   - **The core's other refusals** hold the output back, as step 4's do: `QRC01` and `run_ended` are retried, `stopped`
     (the pause) is held, `denied` is held, and is final at the final boundary.

**SQL (6a).**

- A `test_machine` view's release writes the view's read set and fans each read out to every run with a command
  running on the machine whose job is leased, taking each job's KEY SHARE in id order.
- Every commit of a `test_machine` view rechecks the view's read set at rank 10, as a run's read set is rechecked today.
- The read set carries to the next view of the same placement.
- `qorpera_folder_run_inherit_view_reads` takes a `test_machine` view for any company-audience run whose agent and
  member read the root now. Today it takes only "its own agent's and member's views", which on a test machine would
  leave out every agent but the starter.

**Narrow marks (W6)** are coding turns' (5a). Step 6 adds none: a test machine's reads reach each run's read set
directly (rules 1 and 3).

## Boundaries

A boundary on a test machine covers the whole machine: the service flushes the folder program, releases every recorded
read of the machine (rule 4), then publishes the view's pending changes, each unit with its credits. The executor asks
for it over the host-local control socket (5c), not through the guest.

| When | What happens |
| --- | --- |
| A command starts | its window opens at the service before the guest starts it; the start receipt that carries early output waits for a boundary first |
| Output is read while a command runs (`machine_read`, a worker's read, `machine_cancel`'s receipt) | a boundary first |
| A command ends | its window closes, then its end boundary, then its end and output tail are recorded and the notify continuation follows |
| Files change while a program runs, or while no command runs | a quiet publish about 2 s after the machine's last change (item 3) |
| Stop, sleep, suspend, release or delete | a final boundary with the VM up, then close and the power-off; an unanswered final boundary does not hold the stop past a minute, and what it held is not applied |
| The guest reboots (a new boot) | a final boundary for the old view, then the new boot is recorded and its view opened |
| The starter's authority narrows | renew closes the view `ended`; what was pending is not applied; the VM restarts |
| The service stops cleanly | it releases everything, publishes everything and clears `served_by` |
| The service crashed, or the VM or node was lost | rule 5 above; pending changes are lost ("not applied: the machine was lost") |

A boundary's answer carries step 4's reasons per view (4c), so the report says what was held back and why.

## The report

Each `machine_run`, `machine_read` and `machine_cancel` receipt, and the notify continuation, gives what step 4's
report gives (the view's reasons, what was held back and why), plus: whether this boot has `/company` and, when it has
not, why (the starter's authority, a refused open); the saves credited to the command, with each refused unit's reason;
the other commands that overlapped it (design); and a machine restarted or moved to a new disk by rule 5 or by the
starter's authority narrowing. A member's machine card says only whether the machine works in the company folder, and
why not when it does not (cards show changes, not files).

## What replaces `/mnt/repository`

<!-- TODO -->

## What step 6 reuses from 4c and 5c

<!-- TODO -->

## Slices

<!-- TODO -->

## What this plan amends

<!-- TODO -->

## Proposals and questions

<!-- TODO -->
