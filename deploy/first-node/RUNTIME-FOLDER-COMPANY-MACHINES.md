# Company machines on the folder (F3 step 4): the plan

Status: plan. Slice 4a is being built (#880); the rest is for review before it is built. The design it follows is
[RUNTIME-COMPANY-FOLDER.md](RUNTIME-COMPANY-FOLDER.md) §2 ("When changes are published", "The report") and §5
("Company Computers"), and its build order (step 4). The views are C1b-3's
([RUNTIME-COMPANY-FOLDER-C1B.md](RUNTIME-COMPANY-FOLDER-C1B.md) §1–§9). It builds on step 1's read path
([RUNTIME-FOLDER-SERVICE.md](RUNTIME-FOLDER-SERVICE.md)) and step 3's writes
([RUNTIME-FOLDER-WRITES.md](RUNTIME-FOLDER-WRITES.md)). Where this page differs from them, it says so and why. Facts
about today's office are from master at 08cdda1a3.

## What step 4 delivers

Every Company Computer (an office VM) runs the folder program. Each desktop shows the company folder at `/company`:
the file manager, applications and the desktop terminal work in it, and a change lands about two seconds after the
last one. Each `computer_shell` command also works in `/company`, through a mount of its own, and its changes land
when it ends and each time its output is read. A save is credited to the mount's owner: for a desktop, the
computer's holder (the run holding the screen, or the member who took it over); for a command, the run that started
it. The company's files leave the machine's disk, so the Company File part of `computer_transfer` and the workbench
as a place for work files retire. As the build order says, step 4 unblocks the scale-out switch (#414).

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
| Folder core (SQL) | renew says the view's kind and machine (4a); shell command views, C1b-3b's `computer_shell_command` (4b) |
| Folder service (node host) | desktop views served to their own company machine only, read-write, published after a quiet period; `unsaved_since` reported (4a); command views (4b) |
| Office service (in the VM) | opens and closes the views; asks for publishes at command ends, output reads, drains and stops (4c) |
| Mount helper (in the VM, new) | the one root piece: mounts and unmounts a view's folder program (4c) |
| Office image | the folder program, the helper and their units (4d) |

## Views and machines

**Desktops.** The office service opens a desktop view at each change of holder, as C1b-3 §3 says ("the newest view
wins": a run acquiring the screen, a member's takeover, a private sign-in, and every start of the machine). It calls
`qorpera_folder_view_open` itself, in its own transaction after the holder change has committed (C1b-3 §5), through
its registry credential: two methods join the registry's allowlist (`cloud-company-computer-registry-http.ts`),
`qorpera_folder_view_open` and `qorpera_folder_view_close`. The view's `machine_id` is the allocation of the office's
current activation.

**Commands.** Each `computer_shell` command gets its own view, opened before the command runs (4b). Its owner is the
run that started it.

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
- requests: `mount <name>` with the view (`{environmentId, viewId, pass}`), `publish <name>` (answers the report),
  and `unmount <name>` (publishes first). `<name>` is `desktop-<screen id>` or `command-<command id>`;
- for a mount the helper writes the view file (root, 0600, as the program requires) under
  `/run/qorpera-folder/views/`, and starts `qorpera-office-folder-mount@<name>.service`: the folder program at
  `/run/qorpera-folder/mounts/<name>`, with `--allow-other yes`, run as the execution host's mount unit is
  (`deploy/folder-service/qorpera-folder-mount@.service`: root, `DeviceAllow=/dev/fuse rw`, `AF_UNIX AF_VSOCK`,
  exit 3 = view closed, not restarted);
- the helper refuses names it did not mount and paths outside `/run/qorpera-folder/`. The pass never reaches a
  desktop or a command: only the office service and the helper see it.

**A desktop's mount** is made before the desktop starts, and bound at `/company` in its bwrap. The desktop's
Documents, Desktop and Downloads point at `/company`, and the Terminal and Files open there (today they open in the
workbench). Desktop caches and thumbnails move to memory, and swap is off (§5 "The machine's own disk"). There is no
trash on the mount: step 3 refuses moving a published path into a trash name (`EXDEV`, RUNTIME-FOLDER-WRITES.md
"What is left out"), and a file manager then offers a real delete. If the view closes while the desktop runs (the
program exits 3), the office service stops that desktop.

**A command's mount** is bound at `/company` in a mount namespace of the command's own, inside the computer's shell
namespace (#411); the network, `/tmp` and the process table stay shared (§5). The command starts in `/company`. Its
view closes when no process is left in that namespace (C1b-3 §8), which covers background jobs and programs that
leave the command's process group. Today the shell host starts each command with `bash -c` in one long-lived
namespace per screen, and the shell's bwrap drops every capability, so the shell host cannot make a mount namespace
itself. Two ways (4c picks one after proving it on the real office image, the substrate rule):
- **(a) recommended:** the shell's bwrap keeps `CAP_SYS_ADMIN` in its own user namespace for the shell host alone.
  For each command it makes a mount namespace, binds the command's mount over `/company`, drops every capability, sets
  no-new-privileges and runs the command. Commands stay the shell host's children, so today's reports, stops and
  process groups hold;
- **(b):** the helper starts each command: it enters the shell's namespaces, makes the command's mount namespace,
  then drops to the shell's user.

As §5 says, this attribution is best effort between the commands of one computer (one user, one process table): a
command can misname who saved, never widen what may be read or written.

## Boundaries

| Mount | Publishes |
| --- | --- |
| Desktop | about 2 s after its last change (the folder service's quiet period, 4a); when its last connection leaves (4a); before a drain's or a stop's acknowledgement (4c) |
| Command | when the command's output is read and when it ends (the office service asks the helper, 4c); its last publish when its last process ends, which closes the view (C1b-3 §8 `final`, 4b) |

**Drains and stops.** "The node publishes those final changes before it acknowledges the drain" (C1b-3 §3). Today
`stopResources` stops sessions, the browser, the shell and then the desktop, and `drain.ts` then acknowledges. 4c adds,
after each of those stops and before the acknowledgement: publish the desktop's mount and each command's mount, then
unmount them. The acknowledgement waits for those publishes within the drain's existing deadline; a change still not
saved then is lost, as the design accepts for a crash (founder decision 3), and the report says so.

**Unsaved changes keep the seat.** `qorpera_runtime_office_screen_in_use` counts a screen in use while its desktop view
has `unsaved_since` set (C1b-3 §9). The folder service reports it at each renewal, and renews early when a mount first
has unsaved changes (4a).

## The report

- A command's report goes into its own tool result: the publish at an output read or at the end answers it, and the
  office service adds it (4c).
- A desktop save shows a desktop notification, and its report goes into the next tool result of the run holding the
  screen (§2 "The report"). The folder service has it (the quiet boundary is the service's), and the core has every
  commit by its view. 4e builds it: a notification through the helper's connection, and the holder run's next tool
  result reading the view's commits since the last one shown. Until then the service logs it (4a).

## Slices

Each is its own PR with an exact-head review. 4a and 4b can be built side by side; 4c needs both; 4d needs 4c; 4e
needs 4c.

| Slice | What | Tests |
| --- | --- | --- |
| 4a | SQL: renew's open answer says the view's `kind` and `machineId` (#880; migration `20260930104000`, test 980). Folder service: desktop views from their own company machine only, read-write, quiet period 2 s; `unsaved_since` with the early renewal; a last release publishes first; a parked unit leaves the view's pending changes | 980 (each kind's answer; closed answers unchanged); the service's tests with a stand-in core: a desktop view only from its own office (not the execution host, another office or an unlisted project), a run box not from an office, other kinds refused, a kind or machine that changes closes the view, quiet publish, `unsaved_since` sent and cleared, a parked unit not kept |
| 4b | SQL (C1b-3b, migration `20260930107000`, test 981): the command's row made when it starts, before it runs, and its view: open for the run that starts it, valid while the command has not ended and the screen's generation and the office's activation are unchanged, and a final publish that closes the view in the commit's transaction. Folder service: command views from their own company machine, published only when asked | 981: open only for the screen's live run, generation and activation; an ended command's view takes one final publish, then renews closed; the 30 s report keeps the early row; the service's tests as 4a's |
| 4c | Office runtime: views opened and closed by the office service; the helper and its socket; a desktop's mount at `/company` and its user folders; caches in memory; each command's mount namespace; publishes at output reads and command ends; publishes before a drain's and a stop's acknowledgement. Proven first on the real office image (a mount reaches a desktop and a command writable, through the office service's sandbox and bwrap) | the runtime's tests with a stand-in helper; the helper's tests; on the test machine: a command's view closing when its last process ends, background jobs included |
| 4d | Office image: the folder program, the helper and their units, and swap off, in a new image generation (units need one) | the image contract tests: executables, prerequisites, provenance |
| 4e | The report (above). Retirements (§4 "Retired after acceptance"): the Company File part of `computer_transfer` (the tool's schema, `cloud-file-transfer.ts`, `file-imports.ts`, and the SQL source of `20260908003100`); the workbench as a work area | the transfer tool's tests without the realm; a migration test that the source is gone |
| 4f | Live proof (coordinator runs it) | below |

**Live proof (4f)**, on a test company and one company machine per node:
- a member takes over a computer, edits a document in LibreOffice, and saves: it lands within about 3 s, credited to
  the member, and the other node's machine sees it within about a second;
- from the desktop's file manager: copy, move and delete a folder; from the desktop terminal, a Python script that
  writes 200 CSV files. Each lands, and the web app's history shows it;
- a seat with unsaved changes is not recycled;
- numbers: the folder program's memory per mount (step 0: 60 MB for a 54,000-entry index), and the time from a
  desktop's start to its first listing.

**Deferred (needs Codex):** every check where an agent's run drives the computer. A desktop save credited to the run
holding the screen; an agent's deletion parked as a proposal and reviewed in its next run; a `computer_shell` command
that writes files, landing as one change set when it ends, with its report in the tool result; a takeover while that
command writes, with the agent's changes saved before the member drives.

## Proposals and questions

- **P1 (4c).** One folder program per mount. A computer with four screens and eight commands running has twelve; if
  4f's numbers show that is too much memory, one program could serve several mounts.
- **Q1 (coordinator).** Which LXD projects hold each node's company machines, for `companyMachineProjects`.
- **Q2 (coordinator).** After 4e the office service no longer needs the folder byte route (`/v1/folder-objects/`).
  Does the planned narrowing of its native token ([RUNTIME-FOLDER-WRITES.md](RUNTIME-FOLDER-WRITES.md), "The gateway's
  route for the folder service") land with 4e or on its own?
