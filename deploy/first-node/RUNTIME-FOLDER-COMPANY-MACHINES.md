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
passes the company's review rules, as every command does today, and keeps `/company` through a mount of its own
(amended 14 October 2026: contract, "2026-10-14 amendment: machines work in the folder as on their own disk", item 2).
A command that keeps running, such as an MCP server or a script that pulls live data, also lands its changes about two
seconds after its last change (that amendment, item 3).

A save is credited to the mount's owner, and what a run's mount reads goes to that run's read set (light-threads
item 6). For a desktop the owner is the computer's holder: the run holding the screen, or the member who took it over
(a member has no read set, so a member's view records no reads, C1b-3 §2); for a command, the run that started it.
The company's files leave the machine's disk, so the Company File part of
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

**Not in step 4:** coding machines (step 5) and test machines (step 6). From the 2026-10-14 amendment, links (items 4
and 5) and the machine's own caches for dependencies and builds (item 8) are slices of their own, for every machine
([RUNTIME-COMPANY-FOLDER.md](RUNTIME-COMPANY-FOLDER.md), "Decided on 14 October 2026"). The links' slices are
[RUNTIME-FOLDER-LINKS.md](RUNTIME-FOLDER-LINKS.md) (LK1 to LK6), and the caches' are
[RUNTIME-FOLDER-MACHINE-CACHES.md](RUNTIME-FOLDER-MACHINE-CACHES.md) (MC1 to MC3, with the folder helper passing each
owner's cache folder in MC3); step 4's acceptance (4g) shows them (amendment item 10).

## The parts

| Part | Step 4 adds |
| --- | --- |
| Folder core (SQL) | renew says the view's kind and machine (4a); shell command views, C1b-3b's `computer_shell_command`, for offline commands (4b) and networked ones (4b-2) |
| Folder service (node host) | desktop views served to their own company machine only, read-write, published after a quiet period; `unsaved_since` reported (4a); command views (4b), published after a quiet period while the command runs (4b-2); reads released with the view actor; a newer view takes over a mount's pending changes; a view kept while its last publish has no answer or a refusal that may lift (4c) |
| Folder program (in the VM) | logs what each mount reads, in its state folder; moves a running mount to a newer view; publishes for a mount whose program exited (4c) |
| Office service (in the VM) | opens and closes the views, and gives a screen back when its view is refused; asks for boundaries at command output reads and ends, screen captures, drains and stops; offline and networked commands; its stop control publishes the mounts a stopped service left (4d) |
| Mount helper (in the VM, new) | the one new root piece: mounts, moves, lists and unmounts a view's folder program; brings up an offline command's `lo` (under (b): starts the command) (4d) |
| Provider (node host) | dispatches a stop again when its run ended with no completion; its control observer settles each attempt, and a stop keeps at most two attempt directories (4d) |
| Office image | the folder program, the helper and their units (4e) |

## Views and machines

**Desktops.** The office service opens a desktop view at each change of holder, as C1b-3 §3 says ("the newest view
wins": a run acquiring the screen, a member's takeover, a private sign-in, and every start of the machine). It calls
`qorpera_folder_view_open` itself, in its own transaction after the holder change has committed (C1b-3 §5), through
its registry credential: two methods join the registry's allowlist (`cloud-company-computer-registry-http.ts`),
`qorpera_folder_view_open` and `qorpera_folder_view_close`. The view's `machine_id` is the allocation of the office's
current activation.

**A running desktop moves to the newer view.** Another run of the same agent can acquire a screen whose desktop is
open: the acquire keeps the screen's generation unless the screen was closed
(`20260908000100_runtime_office_registry.sql`), and the contract closes a desktop only before a seat changes hands.
The desktop keeps running, with its open documents. C1b-3 §3 ends the old run's view then, and has "changes the old
holder's programs left pending publish later under the new holder's view". So a desktop's mount does not end with its
view:
- the office service has the helper write the newer view into the mount's view file (`switch`, below). The folder
  program then says hello with the newer view, naming the old one and proving it with the old pass. It keeps its
  FUSE session, inodes, version map and open files;
- the folder service moves the old view's pending changes, open write handles and reads not yet released (below) into
  the newer view, only when both are desktop views of the same company machine and the old pass matches. It keeps a
  closed desktop view's pending changes and unreleased reads for a minute to meet that hello;
- a move outlives the program: one that dies after the helper gave its mount the newer view and before its hello with
  it still names the old view when it starts again, or when the helper's boundary runs it once after an exit (below),
  so the old view's pending changes and unreleased reads move as in a live move (review round 8). How the old view
  and its pass are kept until that hello is 4c's and 4d's to design;
- the program exits 3 (view closed: the office service stops the desktop and unmounts its mount) only when its view
  has closed and no newer view came within that minute.

The core's own reads follow the machine already: a new view carries the old one's read set (C1b-3 §6). A drain needs
no move: it publishes the old view's last changes before its acknowledgement (below), and none of the old view's
changes carry into the member's view (its read set does, but a member's publish does not recheck it: the commit's
rank 10 rechecks only a view acting as an agent).

**A refused or unanswered open.** A company-wide view opens only when its agent and member both read the root
resource (C1b-3 §2). That is the design's screen admission (§5: a run whose default grant was revoked or held back
gets no Company Computer screen), and no other piece checks it. So the office service opens a desktop's view as soon
as a holder change reaches it, before it serves the new holder's first action:
- **a run acquiring a screen:** if the core refuses the view, the office service gives the screen back, and the run's
  computer action is refused with the core's reason. No desktop runs for a run without `/company`. If the core does
  not answer, the office service tries again until the action's deadline, then gives the screen back and the action
  says the company folder is unavailable;
- **a member's takeover** is never refused for the folder (the member may need to stop an agent): if the member's
  view does not open, the desktop starts without `/company`, says why, and the office service keeps trying. A later
  open reaches the running desktop only through the propagated bind 4d tries to prove (below); without it, the
  desktop tells the member to restart the computer to get `/company`;
- **a command** whose view is refused or not answered does not start. Its tool result says why.

**Commands.** Each `computer_shell` command gets its own view, opened before the command runs (4b), a networked one's
as an offline one's (4b-2, amended 14 October 2026: below). Its owner is the run that started it.

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

**What the service keeps when a program leaves.** A folder program can end while the folder service holds changes
for its view: it was killed, or its machine lost the link. The service's view outlives the connection for them:
- a desktop view publishes what it has pending when its last connection leaves (4a). If that publish gets no answer,
  or a refusal that may lift (QRC01, the run check or the pause: Reads, below), the service keeps the view, its
  pending changes and its lease (it goes on renewing it) until the view closes or a publish of the view gets any
  other answer, which drops it (4c; review round 13). A publish refused because the view has ended ("Folder view has
  ended", `denied`), as when a newer view replaced it, is not such an answer but the view's closing: a closed desktop
  view's pending changes and unreleased reads wait the minute for a newer view's hello and move at it (above; review
  round 15). A machine that connects with the view meanwhile joins it. Files its program still holds open wait, and
  keep the view, until a restarted mount or the helper's publisher (each holding the mount's `daemon.lock`) says that
  program is gone and they go back to their last fixed save, or the view ends (4c-3);
- a command view is published when asked (4b), and after a quiet period while held (4b-2), but not when its last
  connection leaves. Then the service keeps it in the same way until a publish asked for it gets an answer other than
  those, or it closes. A closed command view goes: a move is only between desktop views (above);
- so the helper's boundary on a mount whose program exited still finds them (below). A core that does not answer for
  longer than a view's lease (120 s, C1b-3 §1) lets the view expire, and what the service held for it goes then: that
  is every view's lease, not this plan's.

## Mounts in the VM

The office service runs with no capabilities, no devices and no `AF_VSOCK` (`qorpera-company-computer.service`:
`CapabilityBoundingSet=`, `PrivateDevices=yes`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`), and
desktops and shells run under bwrap with every capability dropped. That stays. Mounting needs root, `/dev/fuse` and
`AF_VSOCK`, so it moves to one small root helper, shaped like the network plumb (`qorpera-computer-plumb@.service`):
- a socket `/run/qorpera-folder-helper/helper.sock`, mode 0600, owned by the office service's user, one connection per
  request (the stop control, root, uses it too; below);
- requests: `mount <name>` with the view (`{environmentId, viewId, pass}`); `switch <name>` with the newer view;
  `boundary <name>` (the mount's reads are released, then its pending changes published; it answers the report);
  `unmount <name>` (a boundary first); `drop <name>` (unmounts with no boundary, only for a mount whose view has
  ended: below); and `list` (the mounts it holds, from its view files). `<name>` is `desktop-<screen id>` or
  `command-<command id>`. For offline commands, the helper also brings up the network namespace's `lo` (below);
- a boundary on a mount whose folder program no longer runs (its unit has stopped and systemd is not restarting it):
  - after exit 3 it answers at once that the view closed. A closed view publishes nothing more, so `unmount` and the
    stop control go on and remove the mount, and such a mount never holds up a stop (review round 5);
  - after any other exit the helper asks the boundary without the mount. It runs the folder program once for the
    mount's view (`qorpera-folder publish --view-file <its view file> --state-dir <its state folder>`, with `--final`
    for a command whose processes are gone; 4c). That run hands over the reads the program logged and did not hand
    over (below), asks the folder service to publish what it holds for the view, and exits with the service's
    answer. The service keeps those changes for it (above). A run that got no answer is a boundary with no answer
    (below), so a stop goes on only once the service and the core have answered (review round 6). A run that cannot
    show the read log complete refuses under the log's rule 4 (Reads, below): that is a final answer for the mount,
    so a drain or a stop goes on (rule 3; review round 10);
- for a mount the helper writes the view file (root, 0600, as the program requires) under
  `/run/qorpera-folder/views/`, makes the mount's state folder `/run/qorpera-folder/state/<name>/` empty (its read
  log and version map, below), and starts `qorpera-office-folder-mount@<name>.service`: the folder program at
  `/run/qorpera-folder/mounts/<name>`, with `--state-dir /run/qorpera-folder/state/<name>`, `--allow-other yes`,
  and `--owner-uid <qorpera-office uid> --owner-gid <qorpera-office gid>` resolved from the VM's `qorpera-office`
  account. Those IDs set only the virtual files' ownership; the daemon, view file and state folder remain root-owned.
  It runs as the execution host's mount unit is (`deploy/folder-service/qorpera-folder-mount@.service`: root,
  `DeviceAllow=/dev/fuse rw`, `AF_UNIX AF_VSOCK`, exit 3 = view closed, not restarted). Step 3's program keeps its
  version map under `/run/qorpera-folder/<mount>/` (RUNTIME-FOLDER-WRITES.md), which nothing empties; here 4c's
  `--state-dir` puts the map and the read log in the folder the helper makes (review round 8). `mount` refuses a name
  the helper holds. A `switch` gives the mount the newer view and keeps the state folder, and the old view stays
  movable until the program's hello with the newer one (above). `unmount` and `drop` remove the view file and the
  state folder with the mount, so a mount made again for the same screen starts with neither (review round 7);
- the office service unmounts a mount once its users are gone: a command's once its final boundary has a final answer
  (its view is then closed: by the final publish, or by the office service when that publish was refused; the answer
  covers the command's later output reads, below), and a desktop's whenever its
  desktop ends: when it stops the desktop, after exit 3 (whose boundary answers at once), after another exit without
  the restart (Q3, below), and when a desktop's start fails after its mount was made. So the screen's next desktop
  can mount, and no ended command's view file and state folder stay in memory (review rounds 8 and 9). A command's
  final boundary with no answer, or refused in a way a retry gets past or by the company's pause (Reads, below), is
  asked again by the office service on its own, after 5 s doubling up to 5 minutes, until it has a final answer,
  whether or not a run reads the output again. The view stays valid meanwhile: an ended command's view renews until
  its final publish (4b), and renewal does not check the pause. If the office stops first, its stop asks the
  boundary, and that answer is final (rule 3, below; review rounds 10 and 13);
- the helper refuses names it did not mount and paths outside `/run/qorpera-folder/`. The pass never reaches a
  desktop or a command: only the office service and the helper see it.

**A restarted program must reach its users.** The execution host's unit restarts a program that fails. But `/company` in
a desktop's or a command's namespace is a bind of the program's FUSE mount, so a restarted program's new mount would not
reach it: the desktop would keep a dead mount (`ENOTCONN`). 4d first tries to prove, on the real office image, a bind
that a new mount reaches: the mount's directory bound into the namespaces with mount propagation, so a remount shows
there. Then the restart stays, and the program carries its version map (as on the execution host, step 3) and its read
log, both in the mount's state folder (below). If that cannot be proven, any exit ends the mount's users as exit 3 does:
the desktop is stopped and a command ends, and their mounts are unmounted (above). What the service holds for the view
is still published, and the reads the program logged are still handed over (above, and the helper's boundary after an
exit). What the program had not handed to the service, its open files' unsent bytes, is lost. That is a new loss case,
not founder decision 3's (a machine or node dying), so it needs the coordinator's decision first (Q3).

**The office's stop publishes the mounts left.** The mount units are their own units, so they outlive the office
service; its desktops and commands do not (they are in its cgroup, and `KillMode=mixed` ends them). An office service
never comes back into its activation: a restart has a new `INVOCATION_ID`, which the startup check refuses ("Office
startup binding differs", `qorpera_lock_runtime_office_startup`). A failed office service, a failed drain included,
waits for service recovery (`cloud-company-computer-supervisor.ts`): the provider's stop, then a successor with a new
activation, which ends every old view (C1b-3 §3). So the stop control publishes them: the provider acknowledges a
stop only after its completion (`cloud-company-computer-service-stop-control.ts`, run as root in the VM):
- once the office service's cgroup is empty and before it writes its completion, it asks the helper for the mounts
  left (`list`), asks a boundary on each (a command's is its final one: its processes are gone) and unmounts it. A
  mount whose program exited 3 answers at once, and one whose program exited otherwise is asked without it (above);
- the boundaries are asked on every mount at once, inside the stop control's 100 s
  (`cloud-company-computer-service-stop-control-main.ts`), which keeps its last 5 s to seal its history and write its
  completion, and 10 s before that for the unmounts and drops (`cloud-company-computer-service-stop-folders.ts`).
  `systemctl stop` may take 80 s of the 100 (`cloud-company-computer-service-stop-systemd.ts`; the unit's
  `TimeoutStopSec=70`), so a first run's boundaries get what it left less those 15 s; under a second, the run fails
  without asking. A run that finds its claim retained only observes the stopped service, so its boundaries get nearly
  85 s. An image without the folder helper has no socket and no mount: the step asks nothing;
- a boundary with no answer, refused in a way a retry gets past (QRC01, the run check; Reads, below), or refused with
  no reason while a change still waits (the core did not answer the commit, or a path is left waiting: a command's
  final that did not close its view, or a desktop's boundary that kept a path), fails the stop control's run, so the
  provider has no completion and acknowledges nothing: `qorpera_ack_runtime_office_stop` does not clear the pending
  drain that keeps the old view valid. A desktop's drain asks such a boundary again too. Every other refusal is an
  answer: one under rule 4
  (a read log that cannot be shown complete), the company's pause, and any other the core gives (`denied`, such as a
  read in the view's read set narrowed since). It is final for that mount, whose changes are refused, a member's as
  well as an agent's, and the report says why; the run goes on (rule 3; review rounds 10, 12 and 13);
- today the provider never runs a stop again: `LxdOfficeControlJournal` dispatches a transition's command once, and a
  failed run leaves the stop worker answering `failed` on every later pass. So 4d changes the stop worker
  (`lxd-office-service-stop-worker.ts`): a run that ended with no completion, `failed` or `unknown`, is dispatched
  again (the same command and request), after a wait of 30 s that doubles up to 10 minutes. The next run finds its
  claim retained, only observes, and asks the boundaries again; their publish replays under its operation key
  (RUNTIME-FOLDER-WRITES.md). A run dispatched while an earlier one still runs fails at once on the stop control's
  non-blocking lock (`flock --nonblock`, `cloud-company-computer-preparation-control-main.ts`) and is tried again.
  There is no limit on attempts: the office stays in maintenance until the core and the node's folder service
  answer, which its successor's desktops need for `/company` anyway;
- each attempt is a journal of its own (a journal holds one dispatch), and the provider's 1-second control observer
  (`observeLxdOfficeControlJournals`) settles it as it settles the first: LXD forgets a finished operation after 5 s,
  and the stop worker's passes come further apart. So a retry is a new journal purpose, `service-stop-retry`, in a
  directory `service-stop-retry-<allocation>-<transition>-<attempt>` with the attempt number in its identity
  (`authority.json`), so that `observeExisting` rebuilds the same name. The purpose joins both name patterns (the
  journal's and the observer's) and the identity's key-set check. A run whose result is still `unknown` (the
  observer missed its end, the provider being down for more than 5 s) is dispatched again like a failed one: the
  lock and the retained claim make that safe;
- a stop keeps at most two journal directories, its first attempt's and its latest retry's. Before it dispatches a
  retry, the stop worker records the attempt number and the time of the next one in one retry record per stop, and
  removes the previous retry's directory, whose result it has acted on; the observer takes a directory removed
  during its pass as gone. So the journal root stays far below the 4096 entries `inspectAndAcknowledgeLxdOfficeStop`
  scans (`lxd-office-stop-inspection.ts`), however long a stop is retried;
- an office service lists the helper's mounts only after its startup check has admitted it into a new activation,
  and drops any it finds (`drop`): they belong to ended views, since the predecessor's stop was acknowledged only
  after its stop control unmounted every mount, and a publish under an ended view would be refused. A restart that
  systemd makes in the same activation (`Restart=on-failure`) is refused at the startup check before it touches a
  mount, so the mounts stay for the stop control.

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

- **Offline** (`network` false). The command gets a mount namespace of its own, inside the computer's shell namespace
  (#411), with its mount bound at `/company`, and a network namespace of its own with only `lo`, which is up. `/tmp` and
  the process table stay shared (§5). The command starts in `/company`. It is not an outside effect: its `run`, and
  `write` into it, run at once without the review. Its deletes and moves still pass the review through the commit (P40,
  above). Its view closes with its final boundary, asked when no process is left in its mount namespace (C1b-3 §8),
  which covers background jobs and programs that leave the command's process group (the office service closes it if
  that publish is refused). The office service then unmounts its mount (above).
- **Networked** (`network` true). The command runs in the computer's own network namespace, behind its filter, as
  every command does today, and in a mount namespace of its own with its mount bound at `/company`, as an offline
  command's (amended 14 October 2026, item 2 of the amendment; this plan first gave it no folder). Its `run`, and
  `write` into it, are outside effects and pass the company's review rules (2026-09-25 amendment, item 2). Its view,
  read log, boundaries and final publish are an offline command's. Company data it reads can leave through its
  network, as the founder accepted (item 2).
- **Until a machine carries the folder,** its commands keep today's review (item 5's last point). The runtime classes
  a command by what the office says it carries: an office image from 4e on.

**Who makes the namespaces.** Today the shell host starts each command with `bash -c` in one long-lived namespace per
screen, and the shell's bwrap drops every capability, so the shell host cannot make namespaces itself. Bringing a new
network namespace's `lo` up needs `CAP_NET_ADMIN` over it. Held by the shell host in the shell's user namespace, it
would also let the shell host change the computer's own filter, which the plumb puts inside the shell's namespace for
the computer not to change (`qorpera-computer-plumb`). So the shell host never holds it, and the root helper brings
each offline command's `lo` up. A root process that joins the shell's user namespace could be attached to and taken
over by the office account, which owns that namespace and holds every capability in it, `CAP_SYS_PTRACE` included
(runc's CVE-2016-9962). This plan first gave two ways, for 4d to prove on the real substrate. Neither held, nor did
a third, and 4d takes a fourth (amended 15 October 2026):
- **(a) failed.** The shell's bwrap was to keep `CAP_SYS_ADMIN` for the shell host alone, and for each command the
  shell host would fork a child that makes a mount and a network namespace and waits at a gate, where the helper
  joins only its network namespace and brings `lo` up. On Ubuntu 26.04, bwrap started by the office account carries
  the `bwrap//&unpriv_bwrap` AppArmor label, and the child's namespace creation returned `EPERM`, with the kernel's
  denial of `sys_admin` (capability 21) (#1007, `deploy/test-machine/OFFICE-FOLDER-SUBSTRATE.md`). An image profile
  that gave `/usr/bin/bwrap` user-namespace rights is ruled out: any office-account process, agent code included,
  could then get a user namespace with every capability, which is what Ubuntu's restriction is there to stop.
- **(b) not taken.** The helper's non-dumpable child was to enter the shell's namespaces, its user namespace
  included, and drop to the shell's user. It rests on the office account being unable to attach to a root process
  that sits in a user namespace the office account owns. The live attach check for it was stopped by an automatic
  safety review before it ran, and is not run again.
- **(c) not taken: the command stayed in the initial user namespace.** The helper's child was to join the shell's
  other namespaces and drop to the office account there, never joining its user namespace. That leaves a gap.
  bwrap's `--disable-userns` makes two user namespaces: the shell runs in the inner one, and its pid, uts, ipc,
  cgroup and network namespaces belong to the outer one, which the office account owns and whose parent is the
  initial one. A process in a user namespace's parent whose effective uid owns it holds every capability in it and in
  its descendants (user_namespaces(7)). A command run as the office account in the initial user namespace is such a
  process, so it would hold every capability over the shell's namespaces, the computer's filter included.
- **(c') the command joins the shell's user namespace with no privilege.** For each command the helper (root, in the
  initial user namespace) forks a child. As root, the child moves into the shell's cgroup, joins the shell's mount,
  pid, uts, ipc and cgroup namespaces with `setns`, and the computer's network namespace for a networked command, then
  `chroot`s into the shell's root through `/proc/<shell>/root`. It makes a mount namespace, and a network namespace
  for an offline command, both owned by the initial user namespace, so the office account can neither change them nor
  bring `lo` down. It brings an offline command's `lo` up and binds the command's mount at `/company` with fd-based
  mounts (`open_tree`, `move_mount`), because the tree belongs to the office account. It finds the mount point from
  the shell's root one name at a time with `O_PATH | O_NOFOLLOW | O_DIRECTORY` and no `..`, as `openat2` with
  `RESOLVE_IN_ROOT | RESOLVE_NO_SYMLINKS` would: the helper unit keeps `RestrictSUIDSGID`, whose filter answers
  `openat2` with `ENOSYS`, because a command inherits it as the office's own commands do. It closes every fd but the
  command's stdio, the shell's user namespace and its report pipe (`close_range`; those two close before exec), clears
  its ambient set and keep-caps, and drops to
  the office account (`setresgid`, `setresuid`, no supplementary groups), which leaves it no capabilities. Only then
  does it join the shell's user namespace with `setns`, which the kernel allows because the office account owns the
  outer one. In there it drops its bounding set to the shell's (read from `/proc/<shell>/status`), clears its ambient
  set, sets `SECBIT_NOROOT` and `SECBIT_NOROOT_LOCKED`, sets its capabilities to none, sets no-new-privileges, adds a
  filter that refuses `clone3`, new user namespaces and `setns` and leaves the office's address families only, and
  runs the command. The securebits come before the capabilities go, because setting them needs `CAP_SETPCAP`. The
  shell's map gives the office account its own uid and gid inside, never 0, so a later exec gets no capabilities back;
  the securebits are the backstop, not the fix. The command starts in `/company`, shares the shell's `/tmp` and
  process table, and runs as the office account, so the shell host can still signal it, and the office's stop ends
  it with the shell's cgroup. Reports and stops work as under (b), with the helper's child as the command's parent.

Under (c') the command is a member of every user namespace that owns one of its namespaces, never its parent: the
shell's namespaces belong to the outer user namespace, an ancestor of the one the command is in, and its own mount
namespace (and an offline command's network namespace) to the initial one. It holds no capability in any of them.
The child holds privilege in the initial user namespace while it is root, and in the shell's user namespace only
between the join and dropping its capabilities. It is not dumpable throughout and its memory belongs to the initial
user namespace, so the office account, which holds no capability there, cannot attach to it or read its fds by the
kernel's normal rule. The helper unit holds no `CAP_SETPCAP`: the child changes its bounding set and securebits inside
the shell's user namespace, with the capabilities the join gives it there (the unit says why it holds each capability
it does). So widening the helper unit never widens what a command gets.

The kernel joins a user namespace only for a single-threaded process that shares no fs with another. 4d-4a's
launcher, in Rust, makes the join in the child it forks for the command, before exec.

The helper's proof checks all of this with state, not an attach attempt, an attempt to join a namespace or a change
to the filter (`scripts/prove-office-command-namespaces-vm.sh`):
- the command's user namespace is the shell's, and its ids, `uid_map` and `gid_map` are the shell's commands', never
  0;
- the owners of its mount, net, pid, uts, ipc and cgroup namespaces (`NS_GET_USERNS`, `NS_GET_OWNER_UID`, read by
  the proof from outside), and the owner rule: each owner is the command's user namespace or one of its ancestors;
- its bounding, ambient, permitted and effective sets are the shell's command's, and its securebits and
  no-new-privileges are set;
- the child was still in the initial user namespace, as the office account with no capabilities, before it joined;
- its cgroup and its fds at exec;
- the office's stop ends it and a setsid child of it, and a helper restart does not;
- `clone3` and new user namespaces are refused; the filter it was given (by its digest) refuses `setns`, and the
  command's own `setns(-1, 0)`, which names no namespace, gets the filter's `EPERM`, not the kernel's `EBADF`;
- a networked command works, `lo` included.

It runs each mode twice: once with its own stand-in for the child, which reports its state at each step, and once
with 4d-4a's launcher, `qorpera-folder command`, started as the helper starts it. The launcher's runs check the same
command from outside and from inside, and that the launcher's start report names it (its pid and its mount
namespace). The launcher's filter is pinned by the crate's own test to the digest of the one the stand-in installs.

A networked command's child makes only the mount namespace. It stays in the computer's network namespace, so the
helper has no `lo` to bring up for it (amended 14 October 2026).

As §5 says, this attribution is best effort between the commands of one computer (one user, one process table): a
command can misname who saved, never widen what may be read or written.

## Reads

What a run's mount reads goes to that run's read set (light-threads item 6; C1b-3 §6). So a narrowing after a read
stops the run that read it, and a later save from that mount is rechecked against it (rank 10).
- **The program logs reads.** The folder program logs each open and listing of a core view with its receipt, as the
  run box's read log did (#672, a draft from step 2b-2, rebuilt on step 3's program in 4c). The log is kept in the
  mount's state folder (`/run`, in memory, above), so it outlives the program, and the folder service releases what
  reaches it (below).
- **The log's rules.** How the program logs, sends and hands over its reads, and how the service takes them, is 4c's
  to design; the state folder's life in the helper is 4d's. This plan fixes the rules that design must meet and the
  tests that show it does (Slices); 4c's and 4d's reviews check the mechanics against them (review round 8):
  1. A read through a mount reaches, before it is used, the read sets it must reach (a member-held view releases
     nothing: below): that of the view that publishes a change made from it and of that view's run; that of the run
     shown the mount's own command output, or a capture of its own desktop, while the run holds the mount's view; and
     that of a later run that takes in a command's output (`inherit_view_reads`, below). So after a `switch`, a read
     not yet released goes into the newer view's set and its run's. This holds across restarts of the folder service,
     dropped connections and reconnects, restarts of the program, a `switch` (one whose program died before its hello
     included, above), and a program that died (the helper's boundary after an exit, above). Two things are not
     followed, as C1b-3 §6 accepts ("it does not trace every copy"): a read an earlier holder's view released and
     left on the screen reaches the newer view's set through the open's carry, not the newer run's own set; and
     copies on the machine's own disk, such as a file an offline command left in the shared `/tmp` (Commands, above;
     review round 10).
  2. A mount made again for another view starts with no read log and no version map, as C1b-3 §6 starts a new
     activation's read set empty. Reads of an ended view that were never released go with its mount: by rule 1 none
     of them reached a model or a save.
  3. A drain or a stop is acknowledged only once every mount has a final answer: the folder service's, carrying the
     core's (published, refused or conflicted); a refusal under rule 4 by the program or the service, which no later
     boundary can change; the company's pause (55000: C1b §7 refuses every agent effect after it, and staging refuses
     a paused company's new bytes for every actor, a member's too; a deletion's pause never lifts; review rounds 12
     and 13); any other refusal of the core that no retry gets past, such as a read in the view's read set narrowed
     since (below; review round 13); or exit 3 (above). After a refusal the mount's changes are refused, a member's as
     well as an agent's, and the report says why. A boundary with no answer is not a final answer (review round 10),
     nor is a refusal that a retry gets past: QRC01, or the run check of a run that can no longer act (below; review
     rounds 11 to 13).
  4. What cannot be proven is refused, never assumed. Where the program or the service cannot show that every read of
     a mount reached the service under its view, every later publish of the mount is refused and none of its output
     reaches a model, as a machine's saves are refused after a narrowed read (C1b-3 §6, "The way out for a blocked
     machine"), until the mount is made again: the office service stops the mount's users (the desktop, or the
     command), closes its view and unmounts it, and the screen's next desktop mounts under a new view (rule 2). The
     report says why. A release the core refuses because a read is no longer readable takes the same way out; its
     other refusals do not (below; review rounds 10 and 11).
- **The service releases them** with the view actor (`qorpera_folder_record_release`: one release id per batch of at
  most 10,000 reads, which a retry replays): before each publish of the view, and at each boundary the machine asks
  for. With a live run, the release also writes that run's read set (C1b-3 §6). Reads not yet released when a newer
  view takes a desktop's mount are released under the newer view (above).
- **A member-held desktop view releases nothing** and still publishes: a member has no read set
  (`qorpera_folder_record_view_release` refuses a member-held view), and members' listings carry no receipts
  (RUNTIME-FOLDER-SERVICE.md). Its boundary is a publish alone. That publish rechecks no read set (Views and
  machines, above), but the pause still refuses its new bytes (rule 3).
- **Before output reaches a model** (4d), the office service asks the helper for a boundary: on a command's mount,
  before it hands the command's output to a run, at each output read and at its end; on a desktop's mount, before a
  screen capture reaches the holding run.
  - A boundary that is refused (below) or that has no answer by the action's deadline holds the output or the
    capture back: it does not reach the model, and the tool result says why. An unanswered boundary is asked again
    at the next output read or capture, and a command's final boundary with no final answer also by the office
    service on its own (Mounts in the VM, above). The core refuses with 42501 for several reasons, so the folder
    service tells two of them by the core's message and passes each on as a reason of its own (4c; review rounds 12
    and 13): `unreadable` ("A released read is no longer readable") and `run_ended` ("Run is unavailable"). Its 55000
    stays `stopped`, and every other 42501 stays `denied`.
  - `unreadable`: a release refused because a read is no longer readable (C1b-3 §6) leaves its reads unreleased, so
    every later boundary and publish of the mount would be refused too. For it alone, the office service takes rule
    4's way out at once: it stops the mount's users, closes the view and unmounts it, and a desktop's next start
    mounts under a new view. That is safe: the refused reads reached no model and no save, so they are in no read set
    and the new view's open carries none of them (review round 10).
  - The core's other refusals hold the output or the capture back in the same way, but take no way out (review
    round 11):
    - a refusal a retry gets past: 409 QRC01 "Company folder view changed", which the core calls retryable, and the
      run check of a run that can no longer act (`run_ended`: its deadline passed, or its compute is no longer
      active, while its job is still leased; once the job ends, the view resolves without it). It is asked again, as
      a boundary with no answer is, and is no final answer under rule 3, so a drain or a stop waits for it;
    - the company's pause (`stopped`). It refuses an agent's publish, and a member's that stages new bytes: the view
      lets a member act during the pause, but staging refuses a paused company for every actor. At an output read, a
      capture or a command's final boundary it is asked again, and the output stays held back. At a drain's or a
      stop's boundary it is a final answer (rule 3): the mount's changes are refused, a member's as well as an
      agent's, and the report says the company was stopped. A deletion's pause never lifts
      (RUNTIME-COMPANY-DELETE.md), and a member's takeover while the company is paused must still drain (review
      rounds 12 and 13);
    - a view that has ended (`denied`). When a newer view superseded a desktop's, the mount is the `switch`'s: the old
      run's capture is held back, and the reads and changes move into the newer view (above), whose next boundary
      releases and publishes them; the desktop keeps running. A desktop view that ended with no newer one waits the
      minute for one, and its program then exits 3 (above). A command's view that ended (its lease lapsed, above)
      holds the command's output back for good, and its closed answer ends the final boundary's retries;
    - every other refusal (`denied`), which no retry gets past while the view stands. The main one is "A read is no
      longer readable": a publish of a view acting as an agent rechecks the read sets of the view and of its run, and
      a read in them was narrowed since (C1b-3 §6). Another is "Folder view agent is unavailable", once the agent or
      the member of a view without a live run has gone. At an output read or a capture it is asked again, as the
      next one comes, and the output stays held back. At a command's final boundary, and at a drain's or a stop's, it
      is a final answer (rule 3): the mount's changes are refused, and the report says why. For a narrowed read the
      way out is C1b-3 §6's, a restart of the computer, which C3 offers members; this answer lets the restart's stop
      through (review round 13).
  - A command's final boundary covers every later read of its output: its processes are gone, so it can read nothing
    more. The office service keeps that answer's report for the next tool result and asks no further boundary on
    the mount, which is unmounted (above).
- **Output cites no read.** A command's output, like a screen capture, reaches the model with `readId: null`. A
  context view cites only run releases (`qorpera_folder_run_releases`), and a view release is not one. The reads
  are covered all the same: the view's release wrote them into the run's read set, which the run's recheck checks
  and a narrowing stops. This replaces RUNTIME-FOLDER-SERVICE.md's P8 on a company machine (the runtime releasing a
  command's reads with the run actor): the reads are the folder program's, so the view releases them.
- **A command that outlived its run:** when another run takes in its output, the runtime calls
  `qorpera_folder_run_inherit_view_reads` for that run with the command's view, before the output reaches the model
  (C1b-3 §6: "when a run takes in a view's output"). Nothing calls it today; 4d does. It refuses a view whose
  member is not the run's requester (a later run of the same agent for another member): that run is not shown the
  output, and its tool result says why.

## Boundaries

| Mount | Publishes |
| --- | --- |
| Desktop | about 2 s after its last change (the folder service's quiet period, 4a); when its last connection leaves (4a; kept while its publish has no answer or a refusal that may lift, 4c); before a drain's or a stop's acknowledgement (4d). Its reads are also released before a screen capture reaches the holding run (4d) |
| Command | about 2 s after its last change while its mount holds the view (the folder service's quiet period, 4b-2; amended 14 October 2026); when the command's output is read and when it ends (the office service asks the helper, 4d); its last publish when its last process ends, which closes the view (C1b-3 §8 `final`, 4b), and then the office service unmounts it (4d). Nothing when its last connection leaves: the service keeps its changes for the next boundary the helper asks (above, 4b) |

**Drains and stops.** "The node publishes those final changes before it acknowledges the drain" (C1b-3 §3). Today
`stopResources` stops sessions, the browser, the shell and then the desktop, and `drain.ts` then acknowledges. 4d
adds, after each of those stops and before the acknowledgement: a boundary on the desktop's mount and on each
command's mount, then unmounting them. The acknowledgement waits for those boundaries' final answers (rule 3). A
boundary with no answer by the drain's deadline, or still refused then in a way a retry gets past (QRC01, the run
check), fails the drain, as any stop that does not finish does today ("A timeout is never success",
`cloud-company-computer-drain.ts`): nothing is acknowledged, the member cannot drive yet (the viewer refuses while
`drain_pending`), and the office service waits for service recovery. The provider's stop then publishes the mounts
left before `qorpera_ack_runtime_office_stop` clears the drain, acknowledges nothing while a boundary has no final
answer, and runs the stop again until every boundary has one (above); the publish replays under its operation key
(RUNTIME-FOLDER-WRITES.md). An answer may still say a change was refused, or conflicted (its copy is kept), or that a
mount's changes are refused: because its read log cannot be shown complete (rule 4, final for that mount; review round
10), because the company is paused, or for another refusal no retry gets past, such as a read narrowed since (rule 3;
review rounds 12 and 13). The report says so (below), and none of the old view's changes carry into the member's.

**Unsaved changes keep the seat.** `qorpera_runtime_office_screen_in_use` counts a screen in use while its desktop view
has `unsaved_since` set (C1b-3 §9). The folder service reports it at each renewal, and renews early when a mount first
has unsaved changes (4a).

## The report

- A command's report goes into its own tool result: the boundary at an output read or at the end answers it (after
  the final boundary, its kept answer), and the office service adds it (4d).
- A desktop save shows a desktop notification, and its report goes into the next tool result of the run holding the
  screen (§2 "The report"). The folder service has it (the quiet boundary is the service's), and the core has every
  commit by its view. 4f builds it: a notification through the helper's connection, and the holder run's next tool
  result reading the view's commits since the last one shown, and the publishes refused since, which the office
  service has from the notifications (a refused publish makes no commit). Until then the service logs it (4a).
- A drain's or a stop's boundaries answer with reports too, refusals included (rule 3). The folder helper logs every
  boundary's report as it answers (the refusal, the commit and how many paths had each outcome, never a path or a
  reason), and the office service logs a drain's with the drain too. The stop control writes nothing (its locked child
  runs with no output), so a stop's is the helper's log, whose journal outlives the office service. 4f also puts a
  drain's into the next tool result of the run that held the desktop (a command's goes to its next output read,
  above), and shows it to the member who took over as a notification on that member's desktop. A stop ends the office
  service and its desktops, so a stop's report is the log's alone (review round 13).

### How 4f-2 carries the report

- **Saves come from the core.** `qorpera_folder_view_commits` (4f-2a, migration `20260930495000`) lists a desktop
  view's commits in the order they were made, after a cursor (the last commit shown), with the view's pass, also once
  the view is closed. Each carries its seq (null when it saved nothing), who made it, its run (none once the view is
  detached), and all its units' outcomes as the commit recorded them, so every changed path reaches the report. A
  conflict's run version is kept on the commit's receipt as a conflict copy (P17), so its commit id and unit say
  where it is. A page holds at most the limit's units (1000, a commit's most, by default) and never splits a commit;
  `more` says the next page follows. Only the service role calls it. The office service's desktop folder
  (`cloud-company-computer-desktop-folder.ts`) holds the pass of every view it opens, keeps per view the id of the
  last commit it showed, and reads the ones since when it builds a report. Its registry
  (`cloud-company-computer-registry-http.ts`) names the function.
- **Refusals come from the folder service.** A change set refused whole makes no commit. The folder service sends each
  quiet boundary's answer as a notification on the connection of the helper that holds the mount (the refusal, its
  reason and the change set's paths, or the commit; never a pass), and the helper passes it to the office service on
  its socket. The office service keeps a view's refusals since its last report; a refusal asked again with the same
  reason and paths is kept once, with how many times.
- **The holder run's next tool result, whatever its tool.** Every tool result of a native run is built in one place,
  the native tool boundary (`cloud-native-tool-boundary.ts`, `#result`). For a run whose computer session has held a
  screen, it first asks the office service for the run's report, through the run's computer endpoint
  (`HttpCompanyComputerNativeEndpoint`, a new `folder_report` operation under that run's holder credential), and adds
  the report to the result: a desktop action's result, a refused action's and any other tool's (a `company_read`, a
  connector's call) alike. So a quiet save the folder service publishes after the desktop action returned reaches the
  run's next result, whatever the run calls next. The office service builds a run's report from the views it opened
  for that run: their commits since the last one shown and the refusals since.
  - Each ask names the last report the boundary put into a result. The office service drops only what was shown, so
    a report whose result was never built is given again.
  - Nothing is added when nothing is new. An ask with no answer within a second adds nothing, and the report waits
    for the next result.
  - A report that does not fit into the result's room (`MAX_CLOUD_TOOL_RESULT_BYTES`) says so, and the rest goes into
    the next result.
- **A drain's report.** At a takeover the office service keeps, under the id of the run that held the desktop, the old
  view's commits since the last one shown and the drain boundary's answer, refusals included. The same ask puts them
  into that run's next tool result, whatever its tool (while the member holds the screen the run's desktop actions are
  refused, and a refused one's result carries it too). The office service drops them when the run ends.
- **Notifications.** Each report is also a desktop notification: `notify-send` run as the office account in the
  desktop's session (its `DBUS_SESSION_BUS_ADDRESS`), shown by xfce4-notifyd. It says how many paths were saved,
  refused or conflicted, and why a publish was refused. A drain's report is a notification on the desktop of the
  member who took over, and a member-held desktop's saves are notifications on it alone (no run gets them). The image
  needs `libnotify-bin` and `xfce4-notifyd` (draft PR #1225).
- **Slices.** 4f-2a: the SQL and its test (`434_folder_view_commits.test.sql`), and this design. 4f-2b: the folder
  service's notifications, the helper passing them on, the office service's reports, `folder_report` and
  notifications, the native tool boundary's ask, and their tests. Those include a report in a tool result that is not
  a desktop action's (a quiet save refused after the desktop action returned, reported in the run's next
  `company_read`), and a drain's report in the next result of the run that held the desktop, whatever its tool. Its
  proof on the test machine needs an image with #1225's packages.

## Slices

Each is its own PR with an exact-head review. 4a, 4b and 4c can be built side by side; 4d needs all three and 4b-2; 4e
needs 4d; 4f-1, 4f-1b and 4f-2 need 4d. No company machine mounts the folder before 4e's image, so none of 4a–4c is reachable before
reads, moves to a newer view and offline commands are all in.

| Slice | What | Tests |
| --- | --- | --- |
| 4a | SQL: renew's open answer says the view's `kind` and `machineId` (#880; migration `20260930104000`, test 980). Folder service: desktop views from their own company machine only, read-write, quiet period 2 s; `unsaved_since` with the early renewal; a last release publishes first; a parked unit leaves the view's pending changes | 980 (each kind's answer; closed answers unchanged); the service's tests with a stand-in core: a desktop view only from its own office (not the execution host, another office or an unlisted project), a run box not from an office, other kinds refused, a kind or machine that changes closes the view, quiet publish, `unsaved_since` sent and cleared, a parked unit not kept |
| 4b | SQL (C1b-3b, migration `20260930183000`, test 981): the command's row made when it starts (the native operation's begin), before it runs, saying whether it is networked, and an offline command's view: open for the run that starts it, valid while the screen's generation and the office's activation are the ones the command started in, saving only while the command has not ended, and a final publish that closes the view in the commit's transaction; until that publish an ended command's view still renews, so the service can keep it for the helper's boundary. Folder service: command views from their own company machine, published only when asked, with the request's `final` passed to the commit; a command view kept when its last connection leaves (above) | 981: open only for the screen's live run, generation and activation, and never for a networked command; an ended command's view renews open and takes one final publish, then renews closed; a read released through a command's view for a leased run goes into the run's read set, and after a narrowing of the path's resource the view's save and the run's recheck (`qorpera_folder_run_reads_current`, which `qorpera_folder_assert_run_reads` runs) refuse; once the run has ended the view resolves without a run; 870 and 910: the begin makes the row, and the 30 s report keeps it and fills in the guest's session id; the service's tests as 4a's for where a view may come from, for a command view (only from its own office: not the execution host, another office or an unlisted project; a kind or machine that changes closes the view), no quiet publish and no `unsaved_since` for it (it is published only when asked), and a command view whose last connection left published by a later publish from its machine, with `final` |
| 4b-2 | Follow-up for the 2026-10-14 amendment (items 2 and 3). SQL (a new migration): a command's view opens for a networked command as for an offline one. Folder service: a command view also publishes after a quiet period of about two seconds while its command runs, its reads released first, as well as when asked | 981 changed from "never for a networked command" to "a networked command's view as an offline one's"; the service's tests: a running command's change published after the quiet period, with its reads released before it; a command that ends during the quiet period publishes once, with `final` |
| 4c | Folder program and service: the read log for core views (from #672) and its release with the view actor, before each publish and at each boundary (none for a member-held view); `switch`: a mount moving to a newer view in place, the service moving the old view's pending changes, open write handles and unreleased reads, also when the program dies before its hello with the newer view, and exit 3 only when no newer view came; a desktop view kept when its last publish got no answer or a refusal that may lift (above); how the program logs, sends and hands over its reads and the service takes them, designed in this PR to meet the log's rules (Reads) and reviewed against them; `--state-dir` for the program's mount and for `qorpera-folder publish` (a dead program's read log handed over first), and `--final`; a release refused because a read is no longer readable passed on as a reason of its own, `unreadable`, and the run check ("Run is unavailable") as `run_ended`, each told from the core's other 42501 refusals, which stay `denied`, by its message (Reads; review rounds 12 and 13). A new build record and the installer pins | the service's tests with a stand-in core: reads released before a publish and at a boundary, and under the newer view after a move; a member-held desktop view publishing with no release; a move only between desktops of the same machine with the old pass; a closed desktop view with no newer one kept the minute, then dropped, and a closed command view dropped at once; a desktop view whose last publish got no answer published by a later `publish` from its machine, and dropped once that one is published; one whose last publish was refused during the pause published by a later `publish` once the pause lifts (review round 13); a kept desktop view, and a kept command view, whose later publish is refused by QRC01 or `run_ended` kept and renewed until a later publish gets another answer, and one whose later publish is refused `unreadable`, or `denied` while the view stands, dropped and no longer renewed (review round 14); a kept desktop view whose later publish is refused because a newer view replaced it keeping its pending changes and unreleased reads for the minute, and they move at the newer view's hello (review round 15); a release refused with "A released read is no longer readable" answered `unreadable`; one refused by the run check answered `run_ended`; a publish refused with "A read is no longer readable", and a release under a view that has ended, answered `denied` (review round 13). FUSE tests: a move keeps open files and the version map; exit 3 only without a newer view; and the log's rules, each case required (review round 8): a restart of the folder service, and a dropped io connection, between a read and a write made from it, after which the write's publish releases the read first, and between a read and a boundary with no write, after which the boundary releases the read (review round 9); a quiet publish of a write made after a read releases the read first; a program killed between the view file's replacement by a `switch` and its hello, after which the old view's pending changes and unreleased reads reach the newer view and its run's read set; a program killed after reads, whose log a later `publish --state-dir` hands over before it publishes, each read released once however often it is handed over; a mount made again for another view starts with no read log and no version map; a log that cannot be shown complete refuses every later publish and boundary of the mount, until it is made again under another view. On the hosted database (the acceptance script, as 3c-3): a desktop view's read released through the service, then a narrowing: every later save of the view is refused (two in a row); a read not yet released when the narrowing comes: every later boundary and save of the view is refused |
| 4d | Office runtime: views opened and closed by the office service, and a refused or unanswered open (above); the helper and its socket, and each mount's state folder (made empty at `mount`, kept across `switch`, removed at `unmount` and `drop`) passed to the program with `--state-dir`; the office service unmounting a command's mount once its final boundary has a final answer, and closing its view if that publish was refused (one with no answer, or refused in a way a retry gets past or by the pause, asked again on its own, with a back-off), and a desktop's whenever its desktop ends, a failed start included; rule 4's way out (the mount's users stopped, its view closed and its mount unmounted) for a log that cannot be shown complete and for a release refused because a read is no longer readable, and the core's other refusals (a superseded view, a retryable one, the run check, the pause, any other `denied`) holding output back without it; at a drain's or a stop's boundary, the pause and every refusal but the retryable ones and the run check a final answer, and at a command's final boundary every one but those and the pause (review round 13); a desktop's mount at `/company` and its user folders; caches in memory; a newer view moving the mount; offline commands (mount and network namespaces) and networked ones (a mount namespace with `/company`, amended 14 October 2026; `network`, the review's classes); boundaries at output reads, command ends and screen captures; `inherit_view_reads` for a command that outlived its run; boundaries before a drain's and a stop's acknowledgement, which waits for their answers; the stop control publishing and unmounting the mounts a stopped office service left, before its completion; the provider's stop worker dispatching a stop again when its run ended with no completion, each attempt in its own journal settled by the control observer, and at most two attempt directories per stop; a boundary on a mount whose program exited: at once after exit 3, else asked without the mount (above); an office service admitted into a new activation dropping any mounts it finds (above). Proven first on the real office image (a mount reaches a desktop and a command writable, through the office service's sandbox and bwrap; an offline command has only `lo`; a remount reaching running namespaces) | the runtime's tests with a stand-in helper: a run's refused open gives the screen back and its action is refused with the core's reason, and a run's unanswered open is tried again until the action's deadline, then given back; a member's takeover whose view does not open is not given back: the desktop starts without `/company` and says why; a refused command does not start; the review classes of offline and networked commands; a boundary before output and before a capture; a boundary that is refused, or has no answer, holds the output or the capture back, and the tool result says why; an output read after a command's final boundary published and its mount unmounted reaches the model with the kept report, and after a final boundary that was refused (`denied`, or under rule 4) or whose view's lease lapsed the read gets the kept report and the output stays held back; a mount whose log cannot be shown complete, and one whose release the core refused because a read is no longer readable, has its users stopped and its view closed, and the screen's next desktop mounts under a new view whose captures and saves are not refused for those reads; a release refused under a desktop view a newer one superseded (a `switch` racing the old run's capture) holds that capture back and stops nothing, and the newer view's next boundary releases those reads and publishes the old view's changes; a release refused as retryable (QRC01), and one refused by the run check of a run whose deadline passed while its job is still leased, holds the capture back, stops nothing and is asked again, and a drain waits for it; the QRC01 one is released by a later retry, and the run check's, once the run's job ends, by a later boundary under the view without the run (review rounds 11 and 12); a release refused during the pause holds the output back and is asked again; a drain and a stop during the pause, and a stop of a deleting company's office, are each acknowledged on their first run, with the report saying the company was stopped (review round 12); a member-held desktop with a new file, stopped during the pause, is acknowledged on its first run, and the report says the member's changes were refused; a command that ends during the pause has its final boundary asked again on its own, and its changes published once the pause lifts; a command whose final boundary is refused by the run check (it ended after its run's deadline, while the run's job is still leased), or as retryable (QRC01), has it asked again on its own, and its changes published once the job ends or on the retry (review round 14); a command whose view's lease lapsed has its output held back for good, and its final boundary's retries end on the view's closed answer (review round 14); a command whose final publish is refused (`denied`) has its view closed by the office service and its mount unmounted, and its next output read gets the report saying why; a drain and a stop of a desktop whose view's read set holds a read narrowed since (its publish refused with "A read is no longer readable") are each acknowledged on their first run, with the report saying why (review round 13); a command's final boundary with no answer is asked again on its own, with no output read, until it has a final answer, and the mount is then unmounted; a drain, and a stop, with a mount whose log cannot be shown complete: each is acknowledged, the stop writes its completion on its first run, and the report says why (review round 10); a command's output reaching the model with `readId: null`; `inherit_view_reads` before a later run's output, and a later run for another member not shown it; a drain whose boundary has no answer is not acknowledged; an office service killed during a pending drain, whose stop control publishes the old view's last changes before `qorpera_ack_runtime_office_stop`; a stop whose boundary has no answer, or is refused by QRC01 or the run check, writes no completion (review round 14); a stop with a mount whose program exited 3 writes its completion on its first run; a stop with a mount whose program was killed and not restarted, while the service holds a change, publishes that change before its completion, and writes no completion while the core does not answer; an office service restarted by systemd in the same activation leaves the mounts for the stop control. The stop worker's tests with its fake LXD client (`lxd-office-service-stop-worker.test.ts`) and the real journal and control observer, the client forgetting a finished operation after 5 s (as `lxd-office-operation-observer.test.ts` does): a first run that fails with no completion is dispatched again after the wait, as a new attempt; the observer settles a retry's journal, and a failed retry is seen as `failed` after LXD forgot it and dispatched again; a run whose end the observer missed (`unknown`) is dispatched again; a retry dispatched while the previous run still holds the lock fails and is tried again; after many attempts the journal root holds two of the stop's directories; the last run's completion is inspected and acknowledged. The helper's tests, including that a command's ids, namespace owners, capability sets, cgroup and fds at exec are the ones "Who makes the namespaces" gives (option c', checked with state, not an attach attempt; amended 15 October 2026), that a mount made again for the same screen under another view starts with no read log and no version map, that a `switch` whose program is killed before its hello leaves the old view movable, and that a boundary or `unmount` on a mount whose program exited 3 answers at once, and after another exit, with the service holding changes, runs the folder program's `publish` for the view, which hands over the program's unsent reads and releases them before it publishes those changes, and answers with it. The runtime's tests also: after exit 3 the office service unmounts the desktop's mount, and a new desktop on that screen mounts; a desktop whose start failed after its mount was made starts again with `/company`; an ended command's mount is no longer in `list`. On the test machine: a command's view closing when its last process ends, background jobs included; an offline command reaching nothing but `lo`; a networked command with `/company` (amended 14 October 2026); a second run of the same agent keeping the desktop and its pending changes |
| 4e | Office image: the folder program, the helper and their units, and swap off, in a new image generation (units need one). The toolbox of the 2026-10-14 amendment, item 7: bash and the usual Unix tools, git, Node.js 24 (one `/usr/bin/node`) with npm, npx, `tsc` and `tsx`, Python 3 with pip and uv, gcc and make, mise, ripgrep, fd, jq, sqlite3, curl, zip, unzip and LibreOffice. Two PRs: 4e-1 the toolbox, fuse3, swap off, the dependency recipe and the candidate builder; 4e-2 the folder program, the helper and their units | the image contract tests: executables (every toolbox command answers `--version` from a computer's shell under the office unit's confinement), prerequisites, provenance |
| 4f-1 | Retirements (§4 "Retired after acceptance"): all of `computer_transfer`, not only its Company File part. Legacy sweep step C deleted company objects, which carried every transfer's bytes, so since then the native endpoint refused every realm at authorize and no part of the tool was left to keep. Gone: the tool's schema and its guest answer, `cloud-file-transfer.ts`, `file-imports.ts` (already deleted by step C, C-F1), the Linux workbench file reader and writer with their probes, and the workbench in the company instructions. No SQL: the SQL source of `20260908003100` (`qorpera_native_office_company_file_source`) is dropped by legacy sweep step D, D13 (migration `20260930412000`), which carries the migration test that the source is gone; the closure and the import table go with step E | no capability offers the tool, and no guest parses a transfer; the instructions put the computer's work in `/company` and name no workbench |
| 4f-1b | The workbench as a work area: the desktop's Terminal and Files and the shell start in `/company`, not the workbench | the remount proof's pinned lines and shapes follow |
| 4f-2 | The report (above) | a desktop save's report as a notification and in the holder run's next tool result, a refused publish included; a drain's report, refusals included, in the next tool result of the run that held the desktop and as a notification to the member who took over (review round 13) |
| 4g | Live proof (coordinator runs it) | below |

**Live proof (4g)**, on a test company and one company machine per node:
- a member takes over a computer, edits a document in LibreOffice, and saves: it lands within about 3 s, credited to
  the member, and the other node's machine sees it within about a second;
- from the desktop's file manager: copy, move and delete a folder; from the desktop terminal, a Python script that
  writes 200 CSV files. Each lands, and the web app's history shows it;
- a seat with unsaved changes is not recycled;
- from a computer's shell (amended 14 October 2026): a TypeScript file run with `node` writes into `/company`; a
  networked command fetches a page from the web into `/company`, and it lands; a program that keeps running (a small
  MCP server, or a loop that writes a file every few seconds) lands each change about two seconds after it;
- numbers: the folder program's memory per mount (step 0: 60 MB for a 54,000-entry index); the time from a desktop's
  start to its first listing; the time from a command's start to it running in `/company` (its view's full listing
  comes first); and the folder service's memory per view (about 670 bytes per path, RUNTIME-FOLDER-SERVICE.md).

**Deferred (needs Codex):** every check where an agent's run drives the computer. A desktop save credited to the run
holding the screen; an agent's deletion parked as a proposal and reviewed in its next run; an offline `computer_shell`
command that writes files, landing as one change set when it ends, with its report in the tool result, and reaching no
network; a networked command reviewed, with `/company`, its saves landing (amended 14 October 2026); an agent's run
stopped by a narrowing after its command's read (981 tests the SQL half); a second run of the same agent keeping the
desktop and its pending changes; a takeover while a command writes, with the agent's changes saved before the member
drives.

**Settled in step 4's implementation.** This plan fixes the rules and the tests above. The mechanics behind them are
designed in their slice's PR and reviewed there against those rules, each pinned by the tests named in its row:
- how the program logs, sends and hands over its reads, and how the service takes them: 4c, against the log's rules
  (Reads), by 4c's FUSE tests of each case and the acceptance script;
- the command's early row and the 30 s report: 4b, by 981;
- a boundary refused or with no answer, rule 4's way out, and a final boundary asked again: 4d, by its runtime and
  helper tests;
- drains and stops that wait for every mount's final answer, and the stop worker's retries: 4d, by its runtime, stop
  worker and helper tests;
- a program that dies: 4d's proof of a remount reaching running namespaces, or Q3.

A case a slice's review finds that these rules already decide is fixed in that slice, with a test; this plan changes
only if a rule is wrong (review round 10).

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
  open files' unsent bytes. What the service holds for the view and the reads the program logged still reach the
  core (above). Record that loss case, as founder decision 3 records a machine's, before 4d merges.
  The loss case applies whether or not the remount is proven: the restarted program's abandon hello drops what the
  dead one had not committed, and [OFFICE-FOLDER-REMOUNT.md](../test-machine/OFFICE-FOLDER-REMOUNT.md) records it.
