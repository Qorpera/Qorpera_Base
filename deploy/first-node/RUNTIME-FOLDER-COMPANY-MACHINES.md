# Company machines on the folder (F3 step 4): the plan

Status: plan. Slice 4a is being built (#880 and the folder service's part); the rest is for review before it is built.
The design it follows is [RUNTIME-COMPANY-FOLDER.md](RUNTIME-COMPANY-FOLDER.md) §2 ("When changes are published", "The
report") and §5 ("Company Computers"), and its build order (step 4), with the contract's 2026-10-02 light-threads
amendment, items 5 ("Folder work runs offline") and 6 ("Reads on the company machine go to the run"). The views are
C1b-3's ([RUNTIME-COMPANY-FOLDER-C1B.md](RUNTIME-COMPANY-FOLDER-C1B.md) §1–§9). It builds on step 1's read path
([RUNTIME-FOLDER-SERVICE.md](RUNTIME-FOLDER-SERVICE.md)) and step 3's writes
([RUNTIME-FOLDER-WRITES.md](RUNTIME-FOLDER-WRITES.md)). Where this page differs from them, it says so and why. Facts
about today's office are from master at 08cdda1a3.

## What step 4 delivers

Every Company Computer (an office VM) runs the folder program. Each desktop shows the company folder at `/company`:
the file manager, applications and the desktop terminal work in it, and a change lands about two seconds after the
last one. A `computer_shell` command works in the folder by default: it runs offline, with a loopback of its own and
`/company` through a mount of its own, and it needs no review of outside effects (light-threads item 5). Its changes
land when it ends and each time its output is read. A command that asks for the network is an outside effect: it
passes the company's review rules, as every command does today, and has no `/company`.

What a mount reads goes to its owner's read set, and a save is credited to the mount's owner (light-threads item 6):
for a desktop, the computer's holder (the run holding the screen, or the member who took it over); for a command,
the run that started it. The company's files leave the machine's disk, so the Company File part of
`computer_transfer` and the workbench as a place for work files retire. As the build order says, step 4 unblocks the
scale-out switch (#414).

**What a mount shows and may change** is the core's: each mount is a C1b-3 view, and the view actor decides every
read and every unit (C1b-3 §2). The node only serves it, and checks that the calling machine is the view's own.

**Review needs nothing from the node.** A view's unit that needs the automatic review (an in-house agent's deletion,
or a delegation unit) carries no review id, so the commit parks it as a proposal (P40a,
[RUNTIME-COMPANY-FOLDER-C2.md](RUNTIME-COMPANY-FOLDER-C2.md) §8). The agent's next run for the same member reviews it
(P40b, F2's). Members are never reviewed. After the boundary the mount shows the live folder; the proposal shows only
in the report. This replaces §2's "The folder service asks the harness host of the run that made the change": the
coordinator chose shape B on 4 October 2026 (C2 §8).

**Not in step 4:** coding machines (step 5) and test machines (step 6).

## The parts

| Part | Step 4 adds |
| --- | --- |
| Folder core (SQL) | renew says the view's kind and machine (4a); shell command views, C1b-3b's `computer_shell_command`, for offline commands only (4b) |
| Folder service (node host) | desktop views served to their own company machine only, read-write, published after a quiet period; `unsaved_since` reported (4a); command views (4b); reads released with the view actor; a newer view takes over a mount's pending changes (4c) |
| Folder program (in the VM) | logs what each mount reads; moves a running mount to a newer view (4c) |
| Office service (in the VM) | opens and closes the views, and gives a screen back when its view is refused; asks for boundaries at command output reads and ends, screen captures, drains and stops; offline and networked commands (4d) |
| Mount helper (in the VM, new) | the one root piece: mounts, moves and unmounts a view's folder program; makes an offline command's network namespace (4d) |
| Office image | the folder program, the helper and their units (4e) |

## Views and machines

**Desktops.** The office service opens a desktop view at each change of holder, as C1b-3 §3 says ("the newest view
wins": a run acquiring the screen, a member's takeover, a private sign-in, and every start of the machine). It calls
`qorpera_folder_view_open` itself, in its own transaction after the holder change has committed (C1b-3 §5), through
its registry credential: two methods join the registry's allowlist (`cloud-company-computer-registry-http.ts`),
`qorpera_folder_view_open` and `qorpera_folder_view_close`. The view's `machine_id` is the allocation of the office's
current activation.

**A running desktop moves to the newer view.** Another run of the same agent can acquire a screen whose desktop is
open: the acquire keeps the screen's generation unless the screen was closed (`20260908000100_runtime_office_registry.sql`),
and the contract closes a desktop only before a seat changes hands. The desktop keeps running, with its open
documents. C1b-3 §3 ends the old run's view then, and has "changes the old holder's programs left pending publish
later under the new holder's view". So a desktop's mount does not end with its view:
- the office service has the helper write the newer view into the mount's view file (`switch`, below). The folder
  program then says hello with the newer view, naming the old one and proving it with the old pass. It keeps its
  FUSE session, inodes, version map and open files;
- the folder service moves the old view's pending changes, open write handles and reads not yet released (below) into
  the newer view, only when both are desktop views of the same company machine and the old pass matches. It keeps a
  closed desktop view's pending changes for a minute to meet that hello;
- the program exits 3 (view closed: the office service stops the desktop) only when its view has closed and no newer
  view came within that minute.

The core's own reads follow the machine already: a new view carries the old one's read set (C1b-3 §6). A drain needs
no move: it publishes the old view's last changes before its acknowledgement (below), and nothing of the old view
carries into the member's.

**A refused or unanswered open.** A company-wide view opens only when its agent and member both read the root
resource (C1b-3 §2). That is the design's screen admission (§5: a run whose default grant was revoked or held back
gets no Company Computer screen), and no other piece checks it. So the office service opens a desktop's view as soon
as a holder change reaches it, before it serves the new holder's first action:
- **a run acquiring a screen:** if the core refuses the view, the office service gives the screen back, and the run's
  computer action is refused with the core's reason. No desktop runs for a run without `/company`. If the core does
  not answer, the office service tries again until the action's deadline, then gives the screen back and the action
  says the company folder is unavailable;
- **a member's takeover** is never refused for the folder (the member may need to stop an agent): if the member's
  view does not open, the desktop starts without `/company`, says why, and the office service keeps trying;
- **a command** whose view is refused or not answered does not start. Its tool result says why.

**Commands.** Each offline `computer_shell` command gets its own view, opened before the command runs (4b). Its owner
is the run that started it. A networked command has no view (below).

**Which machine may present a view** (the node's check, 4a). The node's bridge names the machine behind each vsock
CID (`{project, name, physicalId}`, from LXD). A company machine is named after its allocation:
`qorpera-office-<allocation id without dashes>` (`packages/runner-orchestrator/src/lxd-office-guest.ts`). So:
- the folder service's configuration lists the LXD projects of the node's company machines
  (`companyMachineProjects`);
- a hello for a core view is let in from a run box host or from a company machine in a listed project. At the view's
  first renewal the core says its kind and machine (4a), and from then on only that kind's machines are served: a
  run box from a run box host, a desktop (and a command, 4b) only from the company machine named after its
  `machine_id`. A kind this node does not serve yet (a coding session: step 5) is refused;
- a view whose kind or machine changes between renewals is closed. Neither column changes after open (#880's review
  checked every path), so this only guards against a later change.

## Mounts in the VM

The office service runs with no capabilities, no devices and no `AF_VSOCK` (`qorpera-company-computer.service`:
`CapabilityBoundingSet=`, `PrivateDevices=yes`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`), and
desktops and shells run under bwrap with every capability dropped. That stays. Mounting needs root, `/dev/fuse` and
`AF_VSOCK`, so it moves to one small root helper, shaped like the network plumb (`qorpera-computer-plumb@.service`):
- a socket `/run/qorpera-folder-helper/helper.sock`, mode 0600, owned by the office service's user, one connection per
  request;
- requests: `mount <name>` with the view (`{environmentId, viewId, pass}`); `switch <name>` with the newer view;
  `boundary <name>` (the mount's reads are released, then its pending changes published; it answers the report); and
  `unmount <name>` (a boundary first). `<name>` is `desktop-<screen id>` or `command-<command id>`. For offline
  commands, the helper also makes the network namespace (below);
- for a mount the helper writes the view file (root, 0600, as the program requires) under
  `/run/qorpera-folder/views/`, and starts `qorpera-office-folder-mount@<name>.service`: the folder program at
  `/run/qorpera-folder/mounts/<name>`, with `--allow-other yes`, run as the execution host's mount unit is
  (`deploy/folder-service/qorpera-folder-mount@.service`: root, `DeviceAllow=/dev/fuse rw`, `AF_UNIX AF_VSOCK`,
  exit 3 = view closed, not restarted). A `switch` replaces the view file in one rename;
- the helper refuses names it did not mount and paths outside `/run/qorpera-folder/`. The pass never reaches a
  desktop or a command: only the office service and the helper see it.

**A restarted program must reach its users.** The execution host's unit restarts a program that fails. But `/company`
in a desktop's or a command's namespace is a bind of the program's FUSE mount, so a restarted program's new mount
would not reach it: the desktop would keep a dead mount (`ENOTCONN`). 4d first tries to prove, on the real office
image, a bind that a new mount reaches: the mount's directory bound into the namespaces with mount propagation, so a
remount shows there. Then the restart stays, and the program carries its version map as on the execution host (step
3). If that cannot be proven, any exit ends the mount's users as exit 3 does: the desktop is stopped, a command ends.
What the service had pending still publishes when the program's last connection leaves (4a). What the program had
not handed to the service is lost. That is a new loss case, not founder decision 3's (a machine or node dying), so it
needs the coordinator's decision first (Q3).

**A desktop's mount** is made before the desktop starts, and bound at `/company` in its bwrap. The desktop's
Documents, Desktop and Downloads point at `/company`, and the Terminal and Files open there (today they open in the
workbench). Desktop caches and thumbnails move to memory, and swap is off (§5 "The machine's own disk"). There is no
trash on the mount: step 3 refuses moving a published path into a trash name (`EXDEV`, RUNTIME-FOLDER-WRITES.md
"What is left out"), and a file manager then offers a real delete. The desktop keeps the computer's network: what an
agent clicks or types there is an outside effect and passes the review, as today (`computer_desktop` in
`cloud-action-review.ts`).

## Commands: offline or networked

Light-threads item 5 replaces §5's "the network ... stay shared" for a machine that carries the folder. A command
that works in the folder runs without network; one that needs the network is an outside effect. So `computer_shell`'s
`run` takes `network` (false by default):

- **Offline** (`network` false). The command gets a mount namespace of its own, inside the computer's shell
  namespace (#411), with its mount bound at `/company`, and a network namespace of its own with only `lo`, which is
  up. `/tmp` and the process table stay shared (§5). The command starts in `/company`. It is not an outside effect:
  its `run`, and `write` into it, run at once without the review. Its deletes and moves still pass the review through
  the commit (P40, above). Its view closes when no process is left in its mount namespace (C1b-3 §8), which covers
  background jobs and programs that leave the command's process group.
- **Networked** (`network` true). The command runs in the computer's own network namespace, behind its filter, as
  every command does today. Its `run`, and `write` into it, are outside effects and pass the company's review rules
  (2026-09-25 amendment, item 2). It has no folder mount and no view: `/company` is not there. The contract leaves
  open whether such a command sees the folder; this plan takes the narrower choice, so what leaves the machine leaves
  through a reviewed command. It can still read what an offline command left in the shared `/tmp`; the reviewed
  command's text names it, and the folder does not follow copies on the machine's own disk (C1b-3 §6).
- **Until a machine carries the folder,** its commands keep today's review (item 5's last point). The runtime classes
  a command by what the office says it carries: an office image from 4e on.

**Who makes the namespaces.** Today the shell host starts each command with `bash -c` in one long-lived namespace per
screen, and the shell's bwrap drops every capability, so the shell host cannot make namespaces itself. Bringing a new
network namespace's `lo` up needs `CAP_NET_ADMIN` over it. Held by the shell host in the shell's user namespace, it
would also let the shell host change the computer's own filter, which the plumb puts inside the shell's namespace for
the computer not to change (`qorpera-computer-plumb`). So the shell host never holds it: the root helper makes each
offline command's network namespace. It enters the shell's user namespace (checked as the plumb checks a namespace:
under `/usr/bin/bwrap`, of the office account), makes the network namespace there and brings `lo` up. Then, two ways
(4d picks one after proving it on the real office image, the substrate rule):
- **(a) recommended:** the helper hands the network namespace to the shell host as a descriptor. The shell's bwrap
  keeps `CAP_SYS_ADMIN`, never `CAP_NET_ADMIN`, in its own user namespace, for the shell host alone. For each command
  the shell host makes a mount namespace, binds the command's mount over `/company`, enters the network namespace,
  drops every capability, sets no-new-privileges and runs the command. Commands stay the shell host's children, so
  today's reports, stops and process groups hold;
- **(b):** the helper starts each command: it enters the shell's namespaces, makes the command's mount and network
  namespaces, then drops to the shell's user.

As §5 says, this attribution is best effort between the commands of one computer (one user, one process table): a
command can misname who saved, never widen what may be read or written.

## Reads

What each mount reads goes to its owner's read set (light-threads item 6; C1b-3 §6). So a narrowing after a read stops
the run that read it, and a later save from that mount is rechecked against it (rank 10).
- **The program logs reads.** The folder program logs each open and listing of a core view with its receipt, as the
  run box's read log did (#672, a draft from step 2b-2, rebuilt on step 3's program in 4c). It hands the log to the
  folder service on its connection, ahead of any publish it asks for.
- **The service releases them** with the view actor (`qorpera_folder_record_release`: one release id per batch of at
  most 10,000 reads, which a retry replays): before each publish of the view, and at each boundary the machine asks
  for. With a live run, the
  release also writes that run's read set (C1b-3 §6). Reads not yet released when a newer view takes a desktop's
  mount are released under the newer view (above).
- **Before output reaches a model** (4d), the office service asks the helper for a boundary: on a command's mount,
  before it hands the command's output to a run, at each output read and at its end; on a desktop's mount, before a
  screen capture reaches the holding run.
- **A command that outlived its run:** when another run takes in its output, the runtime calls
  `qorpera_folder_run_inherit_view_reads` for that run with the command's view, before the output reaches the model
  (C1b-3 §6: "when a run takes in a view's output"). Nothing calls it today; 4d does.

## Boundaries

| Mount | Publishes |
| --- | --- |
| Desktop | about 2 s after its last change (the folder service's quiet period, 4a); when its last connection leaves (4a); before a drain's or a stop's acknowledgement (4d). Its reads are also released before a screen capture reaches the holding run (4d) |
| Command | when the command's output is read and when it ends (the office service asks the helper, 4d); its last publish when its last process ends, which closes the view (C1b-3 §8 `final`, 4b) |

**Drains and stops.** "The node publishes those final changes before it acknowledges the drain" (C1b-3 §3). Today
`stopResources` stops sessions, the browser, the shell and then the desktop, and `drain.ts` then acknowledges. 4d
adds, after each of those stops and before the acknowledgement: a boundary on the desktop's mount and on each
command's mount, then unmounting them. The acknowledgement waits for those boundaries' answers. A boundary with no
answer by the drain's deadline fails the drain, as any stop that does not finish does today ("A timeout is never
success", `cloud-company-computer-drain.ts`): nothing is acknowledged, the member cannot drive yet (the viewer
refuses while `drain_pending`), and the drain is tried again; the publish replays under its operation key
(RUNTIME-FOLDER-WRITES.md). An answer may still say a change was refused, or conflicted (its copy is kept); the run's
report says so, and nothing of the old view carries into the member's.

**Unsaved changes keep the seat.** `qorpera_runtime_office_screen_in_use` counts a screen in use while its desktop view
has `unsaved_since` set (C1b-3 §9). The folder service reports it at each renewal, and renews early when a mount first
has unsaved changes (4a).

## The report

- A command's report goes into its own tool result: the boundary at an output read or at the end answers it, and the
  office service adds it (4d).
- A desktop save shows a desktop notification, and its report goes into the next tool result of the run holding the
  screen (§2 "The report"). The folder service has it (the quiet boundary is the service's), and the core has every
  commit by its view. 4f builds it: a notification through the helper's connection, and the holder run's next tool
  result reading the view's commits since the last one shown. Until then the service logs it (4a).

## Slices

Each is its own PR with an exact-head review. 4a, 4b and 4c can be built side by side; 4d needs all three; 4e needs
4d; 4f needs 4d. No company machine mounts the folder before 4e's image, so none of 4a–4c is reachable before reads,
moves to a newer view and offline commands are all in.

| Slice | What | Tests |
| --- | --- | --- |
| 4a | SQL: renew's open answer says the view's `kind` and `machineId` (#880; migration `20260930104000`, test 980). Folder service: desktop views from their own company machine only, read-write, quiet period 2 s; `unsaved_since` with the early renewal; a last release publishes first; a parked unit leaves the view's pending changes | 980 (each kind's answer; closed answers unchanged); the service's tests with a stand-in core: a desktop view only from its own office (not the execution host, another office or an unlisted project), a run box not from an office, other kinds refused, a kind or machine that changes closes the view, quiet publish, `unsaved_since` sent and cleared, a parked unit not kept |
| 4b | SQL (C1b-3b, migration `20260930107000`, test 981): the command's row made when it starts, before it runs, saying whether it is networked, and an offline command's view: open for the run that starts it, valid while the command has not ended and the screen's generation and the office's activation are unchanged, and a final publish that closes the view in the commit's transaction. Folder service: command views from their own company machine, published only when asked | 981: open only for the screen's live run, generation and activation, and never for a networked command; an ended command's view takes one final publish, then renews closed; the 30 s report keeps the early row; the service's tests as 4a's |
| 4c | Folder program and service: the read log for core views (from #672) and its release with the view actor, before each publish and at each boundary; `switch`: a mount moving to a newer view in place, the service moving the old view's pending changes, open write handles and unreleased reads, and exit 3 only when no newer view came. A new build record and the installer pins | the service's tests with a stand-in core: reads released before a publish and at a boundary, and under the newer view after a move; a move only between desktops of the same machine with the old pass; a closed view with no newer one dropped after the minute. FUSE tests: a move keeps open files and the version map; exit 3 only without a newer view. On the hosted database (the acceptance script, as 3c-3): a desktop view's read through the service, then a narrowing, refuses the view's next save |
| 4d | Office runtime: views opened and closed by the office service, and a refused or unanswered open (above); the helper and its socket; a desktop's mount at `/company` and its user folders; caches in memory; a newer view moving the mount; offline commands (mount and network namespaces) and networked ones (`network`, the review's classes); boundaries at output reads, command ends and screen captures; `inherit_view_reads` for a command that outlived its run; boundaries before a drain's and a stop's acknowledgement, which waits for their answers; the restart rule (above). Proven first on the real office image (a mount reaches a desktop and a command writable, through the office service's sandbox and bwrap; an offline command has only `lo`; a remount reaching running namespaces) | the runtime's tests with a stand-in helper: a refused open gives the screen back, an unanswered one is tried again, then given back; a refused command does not start; the review classes of offline and networked commands; a boundary before output and before a capture; `inherit_view_reads` before a later run's output; a drain whose boundary has no answer is not acknowledged. The helper's tests. On the test machine: a command's view closing when its last process ends, background jobs included; an offline command reaching nothing but `lo`; a networked command without `/company`; a second run of the same agent keeping the desktop and its pending changes |
| 4e | Office image: the folder program, the helper and their units, and swap off, in a new image generation (units need one) | the image contract tests: executables, prerequisites, provenance |
| 4f | The report (above). Retirements (§4 "Retired after acceptance"): the Company File part of `computer_transfer` (the tool's schema, `cloud-file-transfer.ts`, `file-imports.ts`, and the SQL source of `20260908003100`); the workbench as a work area | the transfer tool's tests without the realm; a migration test that the source is gone |
| 4g | Live proof (coordinator runs it) | below |

**Live proof (4g)**, on a test company and one company machine per node:
- a member takes over a computer, edits a document in LibreOffice, and saves: it lands within about 3 s, credited to
  the member, and the other node's machine sees it within about a second;
- from the desktop's file manager: copy, move and delete a folder; from the desktop terminal, a Python script that
  writes 200 CSV files. Each lands, and the web app's history shows it;
- a seat with unsaved changes is not recycled;
- numbers: the folder program's memory per mount (step 0: 60 MB for a 54,000-entry index); the time from a desktop's
  start to its first listing; the time from a command's start to it running in `/company` (its view's full listing
  comes first); and the folder service's memory per view (about 670 bytes per path, RUNTIME-FOLDER-SERVICE.md).

**Deferred (needs Codex):** every check where an agent's run drives the computer. A desktop save credited to the run
holding the screen; an agent's deletion parked as a proposal and reviewed in its next run; an offline
`computer_shell` command that writes files, landing as one change set when it ends, with its report in the tool
result, and reaching no network; a networked command reviewed, without `/company`; a narrowing after a command's
read stopping its run; a second run of the same agent keeping the desktop and its pending changes; a takeover while
a command writes, with the agent's changes saved before the member drives.

## Proposals and questions

- **P1 (4d).** One folder program per mount. A computer with four screens and eight commands running has twelve; if
  4g's numbers show that is too much memory, one program could serve several mounts.
- **P2 (after 4g).** The folder service lists each view in full before serving it and keeps a tree per view. At
  50,000 entries that is about 50 list calls and about 33 MB per command. If 4g's numbers ask for it, the service
  shares one listed company-wide tree between a machine's views (they all show the company-wide view), with receipts
  still per view.
- **Q1 (coordinator).** Which LXD projects hold each node's company machines, for `companyMachineProjects`.
- **Q2 (coordinator).** After 4f the office service no longer needs the folder byte route (`/v1/folder-objects/`).
  Does the planned narrowing of its native token ([RUNTIME-FOLDER-WRITES.md](RUNTIME-FOLDER-WRITES.md), "The gateway's
  route for the folder service") land with 4f or on its own?
- **Q3 (coordinator, only if 4d cannot prove a remount reaching running namespaces).** A folder program that dies (an
  out-of-memory kill) would then end its desktop or command, and lose what it had not handed to the service: its
  open files' unsent bytes. Record that loss case, as founder decision 3 records a machine's, before 4d merges.
