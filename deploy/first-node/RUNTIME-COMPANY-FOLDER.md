# The company folder on every machine

Status: design, not built. Founder decisions of 27 September 2026 are recorded
in the contract as the 2026-09-27 amendment "every machine works in the
company folder" (section 19). The founder's later decision the same day, that
coding machines mount the folder too and keep repositories and worktrees in
it, is part of that amendment. This document is the design those decisions
refer to.

> **Note, 2026-09-27 (evening).** The contract's company folder layout (section
> 5.6 and the layout amendment in section 19) fixes the folder's seeded tree,
> makes everything approved by default (no path needs a member's approval),
> and moves the storage core's version per file ahead of writes through the
> mount (section 9; the core is designed in
> [RUNTIME-COMPANY-FOLDER-CORE.md](RUNTIME-COMPANY-FOLDER-CORE.md)).
> The automatic review of deletes, moves and delegation is unchanged. Where
> this design speaks of protected paths producing proposals, none are
> configured by default.

> **Note, 2026-09-28.** The founder decided how machines reach the folder
> (F3 design page, https://claude.ai/artifact/FovWsxGxvjByUnaUKmhc8r; contract
> section 19, "2026-09-28 amendment: how machines reach the company folder").
> The design also takes account of three changes decided the same day:
> - Stateless Compute: nodes are to become interchangeable. Live since v144
>   for runs whose login is in the vault (contract, "2026-09-28 amendment:
>   model logins live in the vault").
> - Computers get internet and long-running shells: contract, "2026-09-28
>   amendment: compute for agents" (#409 item 2, ratified), build in draft
>   #411.
> - Coding sessions stand by between turns: the same amendment (#409 item 3),
>   build in #430.
>
> The section [Decided on 28 September 2026](#decided-on-28-september-2026)
> records the result. Where it differs from a later section, it governs, and
> the later sections carry "amended 2026-09-28" markers.
>
> Where the contract says "build step 4", it means the storage core's
> writing side (C1–C3) and the reset. This holds in section 19, the
> checkpoint, section 20 and launch acceptance.

## Decided on 28 September 2026

Words: a *computer* is one agent's screen with its terminal and browser; a
*machine* is a virtual machine. A company machine (older text: Company
Computer) hosts up to six computers.

### How a machine reaches the folder (founder decision 1)

- **One folder service per node host.** It is the same program on every
  node. It holds the platform's service credential. It does the checks of
  section 1: authority, read records, publishing and reports. The storage
  core checks every save again in the database.
  - It keeps no state beyond memory: recent listings and chunks, and the
    small buffers of bytes not yet sent.
  - It reads chunks straight from the NAS object share, after the core has
    authorized the path and named the manifest. Both nodes mount that share
    at `/srv/qorpera/canonical` (the coordinator, 2026-09-28;
    `deploy/node-parity/README.md`). It never uses the object gateway's byte
    routes.
  - It writes new chunks through the object gateway on its own node. Today
    only node 1 runs one. Identical Nodes (S3) adds one per node, each with
    its own journal folder.
- **A folder program in every machine.** A FUSE adapter inside each machine
  shows `/company`. It talks to the folder service of the node the machine
  runs on, over the machine's vsock link.
  - That link is not the machine's network. A machine whose shell has
    internet therefore stays blocked from the NAS, the nodes and private
    addresses.
  - LXD gives every VM a vsock link (`volatile.vsock_id`), so no device is
    added. Step 0 confirms this first.
- **Views.** Each mount is a view with one owner. On a test machine the
  owner is the starter, while saves are credited per command (below). In the core it is a
  `qorpera_folder_views` row (C1b-3, as answered on #432):
  - a pass of 32 random bytes, of which SQL keeps the sha256;
  - a lease of 120 s that the folder service renews every 40 s.
  - The node's folder service checks that a call comes from the machine the
    view names, by the calling vsock CID. The node assigns the CID, and the
    machine cannot choose it.
  - On company and coding machines, where agents are not root, commands,
    shells and desktops cannot open the vsock link themselves: their units
    run with `RestrictAddressFamilies` without `AF_VSOCK`.
  - On a test machine an agent is root. The guard there is the CID check
    plus exactly one view per machine.
- **Not chosen.**
  - A virtiofs disk per view, shared from the host. It needs a disk for
    every computer and every coding session, it cannot tell desktops apart
    behind virtiofsd, and it shows other machines' changes late.
  - A share straight from the NAS. It bypasses versions, review, receipts
    and per-path authority, which is the second reason the live tree was
    retired in August. The first reason, a shell beside the login, is
    answered by the run box (section 4). No machine mounts the NAS directly.

### Which view each machine gets (founder decision 2)

| Machine | View | Owner of saves |
| --- | --- | --- |
| Run box (section 4) | the run's authority | the run |
| Company machine: one mount for each computer's desktop, and one for each `computer_shell` command (section 5) | the company-wide view: paths whose covering resource is the root `company_shared` resource, plus `rules/` read-only | the desktop's mount: the computer's holder (the run holding it, or a member who took it over); a shell command's mount: the run that started that command |
| Coding machine, one mount per attached session (section 6) | the coding agent ∩ the session owner, `agents/**` and `rules/**` read-only | the session |
| Test machine, one mount per machine | the company-wide view, as on a company machine (open question 5, settled by the compute amendment, item 4) | the agent whose command made the change; changes made with no command running go to the machine's starter |

- A company machine never shows a narrower folder, even to an agent that
  may read it. Its computers are not walls between agents (section 12). Such
  folders are worked on from the agent's own run box. A test machine follows
  the same rule, since any agent of the company may use it (compute
  amendment, item 4).
- On a test machine, `/company` is mounted only when the starter's
  authority covers the company-wide view. Its one view is opened by the
  starter's run, holds the lease and sets what can be seen. Any agent whose
  authority covers that view may run commands there, as on a computer.
  - The view's pending changes are published at each command's end, and
    while a command runs each time its output is read (compute amendment,
    item 4: "when it ends (and while it runs, item 2)"). Changes made while
    commands run are credited to those commands' agents and requesters, taken
    from #419's command records on the node. When commands overlap, each of
    their receipts lists the others.
  - Changes made while no command runs are credited to the machine's starter,
    at the next publish or at stop.
  - Reads made while commands run are recorded in the read set of every run
    with a command running at the time. Reads made while none runs are
    recorded on the starter's view.
  - The agent is root, so this attribution is best effort: it can misname
    the saver, never widen the view.
- A computer's holder changes only as #409 item 1 allows. A computer with a
  running command stays in use, and its desktop is closed before the seat
  changes hands. A member who takes over while an agent's command runs does
  not take over that command's saves: they stay the agent's.
- A view stays open after its owner's run ends while the programs it serves
  run: a shell command's view until that command and its background
  processes end, and a desktop's until the computer changes hands or closes.
  - Saves are attributed to the view's agent and to the member of its last
    holder.
  - A unit that needs the automatic review waits for that agent's next turn
    for the same member, and the agent is told.
  - Reads are recorded on the view, and that next run inherits them in its
    read set (the answer to C1b-3's question 4 on #432).
- A test machine has internet. Once `/company` is mounted on it, starting a
  command and typing into one are outside effects and pass the automatic
  review, like a computer's shell; a worker's commands pass under its
  agent's rules (compute amendment, item 4, ratified). Until then a machine
  has no company folder and its commands are not reviewed.

### What a crash loses (founder decision 3)

- When a machine or node dies, the changes of a command or save that were
  not yet published are lost: paths, bytes and moves.
- They are reported as "not applied: the machine was lost". A run reports
  them in its next tool result, or at the agent's next turn if the command
  outlived its run. A member who held the computer is told the next time
  they open it.
- Nothing a company owns is kept on a node or a machine disk to rescue them.
- Published changes are on the NAS and in the database.
- The window is one publish boundary (section 2).

### Nothing on a node

- The folder service keeps memory caches only.
- Machines keep their page cache and the folder program's memory cache.
- Bytes a program writes go to the NAS as chunks that are not part of the
  folder until published, under an upload intent (core §2, C1d). The
  machine's memory holds at most one partial chunk per open file.
- A coding session's cache folders are rebuildable, and a test machine's disk
  is throwaway. Neither ever holds company files.

### Build order (replaces section 9's mount steps)

The storage core delivers the server side in slices:
- C1a: reads and lists;
- C1f: the feed and the clock hint, built by F3;
- C1b: run, computer-holder and coding-session actors, read records and
  review in SQL;
- C1c and C1d: the byte-route fence, upload intents and GC;
- C2 and C3: structured files and writers;
- C4: tolerant readers, so real runs can exist on a folder-v2 company.

The machine side follows. Each step is its own release-train PR, accepted
live before the next:

| Step | What | Waits on | Retires |
| --- | --- | --- | --- |
| 0 | Spike on a throwaway VM in node 2's build space. It first confirms the built-in vsock link, then runs the folder program against a synthetic tree on the NAS. It measures `rg`/`fd` at about 27,000 and 50,000 files, single-file latency, git reads on the mount and invalidation time, and picks the adapter language | node 2's build space (S3) | — |
| 1 | Folder service on both nodes, and the folder program. A folder-v2 company made by an operator is mounted read-only on the execution host, outside any box | C1a, C1f, and C1c's activation checks before a folder-v2 company holds data in production (step 1 reads the NAS itself and never uses the byte routes C1c fences) | — |
| 2 | Run box with `exec_command`/`write_stdin` over the read-only mount | step 1; C1b run actors and read records; C3 and C4, so a real run can exist on a folder-v2 company | — |
| 3 | Writes: boundaries, change sets, reports, conflicts, reviewed units, `apply_patch`; streamed binary writes and the folder service's upload binding; restore in the web app (from old step 4; the file history view is core slice C4). A write spike first, including two machines on two nodes editing the same file | C1b–C1d, C2, C3 | the five `company_*` tools, for folder-v2 companies |
| 4 | Company machines: a new office image with the folder program, a mount for each desktop and each shell command, desktop folders in `/company`, saves after a quiet period, shell commands per command and reviewed. Unblocks the scale-out switch (#414) | step 3; #411 in the same image | the Company File part of `computer_transfer`; work files in the scratch area |
| 5 | Coding machines: one mount per attached session, code areas (section 6), a final publish before sleep and archive | step 3; coding standby (#430) | the private repository folder, its seed and export chain, the 64 MiB bundle |
| 6 | Test machines: one view per machine, publishing at command end and while a command runs (section 2) | step 3; test machines (#419, Rebuild Map C4) | `/mnt/repository` and copies to the machine's disk |

Steps 4, 5 and 6 do not depend on each other. Milestone M3 of the Rebuild Map
is reached when two machines on two nodes edit the same folder live and
launch items 6 and 13 pass without copies.

## Goal

The Company File is the company's whole folder: its full digital state, not
one file. Agents work in it exactly the way an agent works in its own
computer's files. They list, search, read, edit, write, create folders, move,
rename, copy, delete and run scripts over it with ordinary tools.

The folder lives once, on the NAS. Machines are scalable compute that are
bolted onto it. Agent run machines, Company Computers and coding machines each
mount the same live folder at `/company`. File explorers show it and shells
work in it. No machine keeps the company's files on its own disk. Code lives
in the folder too: coding agents create and keep repositories and worktrees
there, and search across all company data.

## What exists today (master 14baeadd7)

**Agent tools.** Agents reach the folder only through five tools:
`company_list`, `company_read`, `company_write`, `company_mkdir` and
`company_delete`.
- A listing shows one level, 50 entries per page.
- A read returns at most 4 KiB, and only UTF-8 text.
- A write replaces the whole file with at most 32 KiB of text, or copies a
  completed shared export of up to 8 MiB.
- There is no search, no move and no rename.
- Every delete is a proposal that waits for a member.

**No shell in an agent run.** Codex runs with `shell_tool` and `unified_exec`
disabled and a read-only sandbox (`cloud-codex-tool-session.ts`). Its bwrap
box holds `codex/auth.json`, the member's model login, so a shell there could
read that login. The run's slot unit has `PrivateDevices=yes`,
`NoNewPrivileges=yes` and no capabilities (`qorpera-shared-run-host@.service`).

**The Company Computer.**
- The shell stops a command after 15 seconds and kills it when its output
  passes the limit (`OFFICE_COMMAND_OUTPUT_LIMIT`).
- It has no network and sees only the NAS workbench, not the Company File.
- Single files of up to 8 MiB move in and out one at a time through
  `computer_transfer`.
- All desktops share one workbench.

**The coding machine** has a shell whose commands have no time limit of their
own and keep running between turns, and open network egress. Sessions are not reviewed, and it sees only the repository
workspace.

**The retired live tree.** `e0b75fd04` (26 August) passed the NAS-backed live
tree into runner VMs. `f0574bdf5` (28 August) replaced it with the path tools,
and the production mount was detached on 29 August. There were two reasons:
- the shell sat next to the login;
- raw writes bypassed versions, receipts and proposals.

This design keeps the live folder and removes both reasons.

**Server.**
- A change covers one path.
- Each change re-stages and re-verifies the whole tree and compare-and-swaps
  the global head. The commit is tried four times in all, and on a fourth
  `PT409` the write fails as "Company File head changed".
- There is no move and no revision feed a client can read.
- Bytes are content-addressed objects on the NAS: 4 MiB chunks, 8 MiB
  objects, 256 MiB per file.
- A tree holds at most 50,000 entries, and its manifest at most 8 MiB. That
  binds at roughly 27,000 files. Total size is at most 1 TiB.
- A listing and a read each record every path they touch in the run's read
  set. Every recorded path is rechecked, one at a time, before each model
  request, send and mutation, and child wakes inherit the set.

## The shape

```
                 NAS: the company folder (objects and versions, one place)
                      ▲ authorized reads             ▲ change sets
                      │                              │ (the mutation gateway)
          ┌───────────┴──────────────────────────────┴───────────┐
          │ folder service (trusted, outside every model box)     │
          │ authority · read sets · presence · publish · reports  │
          └──────┬──────────────────────┬───────────────────┬────┘
            /company               /company              /company
     ┌───────────┴─────────┐ ┌──────────┴──────────┐ ┌──────┴──────────────┐
     │ run box (per run)   │ │ Company Computer(s) │ │ coding machine      │
     │ shell + apply_patch │ │ file explorer,      │ │ per-session mounts, │
     │ no logins, no net   │ │ terminal, apps      │ │ worktrees in code/  │
     └─────────────────────┘ └─────────────────────┘ └─────────────────────┘

  model harness (Codex and the member's login): its own box, no mount, no shell
```

(Amended 2026-09-28: the folder service runs on every node host, and each
machine reaches the service of its own node over vsock.)

## 1. The folder service

**What it is.** A trusted service that runs outside every box the model can
reach and holds the machine's service credentials. It is a new front on
today's gateway, not a second authority: the same code decides path
authority, receipts, presence and protected-path proposals.

**Where it runs.** (Amended 2026-09-28: the folder service runs once per
node host, and each machine runs a folder program that reaches it over vsock;
see [Decided on 28 September 2026](#decided-on-28-september-2026).)
- **On an execution host:** the folder program, as a host-level unit outside
  the slot units. It holds `/dev/fuse` and mounts each run's view with
  `allow_other` before the run box starts, and the box unit binds that mount.
  The slot unit itself stays unprivileged.
- **On a company machine:** the folder program as a system unit with its own
  memory budget: a mount for each computer's desktop and each shell command
  (section 5).
- **One-run LXD runner VMs** (the older lane) get no mount. The shared
  execution host is the run machine for this design, and the LXD guest
  bootstrap keeps refusing FUSE (`lxd-runner-bootstrap.ts:824`).

**What it serves.**
- Whole-subtree authorized listings.
- Attributes: size, the time of the current version, and the executable flag.
- Byte ranges of any content.
- A feed of file changes and of authority changes (see Freshness).

**What it accepts:** change sets (section 2).

**Kernel side.** A Linux FUSE filesystem, as a thin adapter that talks to the
folder service of its node over vsock (amended 2026-09-28; it was a local
socket). The adapter's language (a maintained TypeScript binding, Rust
`fuser` or Go `go-fuse`) is chosen in step 0, a spike on node 2 against the
real NAS (amended 2026-09-28; it was build step 2). The spike measures `rg`
over a tree at today's real limit (about 27,000 files) and over a synthetic
50,000-file tree.

**Caching.** Bytes stream from the NAS and are held only in memory: the kernel
page cache plus a bounded in-process cache keyed by content hash. Nothing of
the company folder is written to a machine's disk.

**Freshness.** The feed invalidates changed paths, so another machine's
change is visible within about a second. Grant and resource changes also
arrive on the feed: they reload the view and trigger the recheck in section 3.

**Uploads.** Today's upload binding belongs to a Codex run lease
(`object-gateway/src/native-objects.ts`), and its check has no path. The
folder service gets its own binding: run-scoped on an execution host, and
scoped to the mount's view on a company machine (amended 2026-09-28: the
desktop's holder, or the run that started a shell command; section 5). The
path is still checked at commit. Memory holds at most one partial chunk per
open file.

## 2. Writes: change sets

### When changes are published

**In the run box**, at every tool result: when a command ends, and each time
a running command yields output to the model. There is one boundary per box,
and background processes are included. When the run ends, its processes are
stopped first. A last boundary then publishes what they had open, and its
report goes on the run's receipt.

**On a Company Computer**, per desktop, after a quiet period of one to two
seconds following any change on the mount from that desktop. That covers an
application's save, a file-manager copy, move or delete, and a
desktop-terminal command. `computer_shell` sessions follow the run-box rule.
(Amended 2026-09-28: each `computer_shell` command has its own mount and
publishes when it ends and each time its output is read; it may outlive its
run, and its last publish comes when its processes end; section 5.)

**On a test machine**, the view's pending changes publish the same way: when
a command ends, and each time a running command's output is read (amended
2026-09-28: compute amendment, items 2 and 4). Changes made while no command
runs are published at the next publish or at stop, credited to the
machine's starter.

**Never published:**
- a file still open for writing by any process (it waits for a later
  boundary);
- lock, swap, backup and trash names: `.~lock.*#`, `~$*`, `*.swp`, `*.swo`,
  `.#*`, `*~`, `.Trash-*`;
- a file that is created and removed between two boundaries.

### How pending bytes are handled

Written bytes stream straight to the NAS object store as content-addressed
chunks. They are not visible until published.

**Base versions** (see below) are kept per run in the folder service's
version map. The map is saved with each command's read record, so a
restarted service reloads it.

A change set has an operation key: the run, the box and the boundary number.
Its manifest is staged in the object store before commit, so a restarted
folder service commits or reports it exactly once (contract section 10).
Everything pending since the last boundary is lost if the service, the
machine or the node dies: paths, bytes and moves (founder decision,
2026-09-28). The run's next tool result reports it as "not applied", with the
reason.

### What gets published

At each boundary the service computes the net change per path: created,
changed, deleted, or moved. A rename inside the mount is a move. A temporary
file renamed over its target counts as a change to the target.

### The base version of a path

The base version is the newest version of that path the run has seen, taken
from its version map. When the run never read the path, the base is the version
at the moment the box first opened it. A blind `echo > f` therefore still
cannot overwrite a version the run never saw.

### Units

A change set is made of units. Each unit applies whole or not at all, which
is contract section 5.1's "atomic path set". The units are:
- one file change;
- one move, of a file or a whole folder: its source and destination together;
- one new folder together with everything created inside it at the same
  boundary;
- one deleted folder together with everything inside it (`rm -rf`).

A unit whose parent comes from a parked or refused unit parks or fails with
that unit. An example is a new file created inside a moved folder while the
move waits for approval.

All clean units of a boundary land in one commit with one sequence number
(amended 2026-09-28: there is no head; each path has its own version, see
[the core](RUNTIME-COMPANY-FOLDER-CORE.md)).

### The outcome of each unit

- **Clean.** It is committed in that change set's commit.
- **Conflict.** A base version moved, so the unit is not written; nobody's
  work is overwritten (no last-writer-wins). The run's version is kept as an
  immutable object on the run's receipt. It is shown read-only in the box
  under `~/conflicts/` and can be restored from the receipt after the run.
- **Protected.** The unit becomes a proposal and waits for a member. Since
  2026-09-27 no path is protected by default; the one standing case is a hire
  by an agent whose own authority is restricted (contract 5.6, 14.1).
- **Delete or move of an ordinary path, or a delegation unit.** All such units
  of the boundary go to the automatic review together, as one reviewed action
  that lists them all (2026-09-25 amendment). Since 2026-09-27 (contract 5.6)
  delegation units are: a new agent folder, an agent's archive or
  reactivation, a new `group.md`, and any change to a routine file except the
  routine run's own end-of-run decision, which is reviewed only when it
  changes the routine's instructions or title. The folder service asks the harness host of the
  run that made the change; a Company Computer reaches it through that screen
  holder's run. (Amended 2026-09-28: through the owner of the mount that
  saved, section 5: the holder's run for a desktop save, and the run that
  started it for a `computer_shell` command.)
  - **Allow:** the units land with the clean ones.
  - **Deny:** they are restored in the mount and reported.
  - **Ask:** they are parked on the card and the other units land now. On
    approval the parked units apply without a retry, provided their base
    versions still hold; otherwise they are reported as not applied. Where
    no card can be raised (a worker or a group chat, 2026-09-25 amendment,
    item 5), an ask counts as a deny.

After every boundary the mount shows exactly the live folder. A pending
proposal or card is visible only in the report.

### The report

Every tool result ends with a report of each changed path: saved, waiting for
approval, denied, not applied (and why), or conflict (with where the run's
version is kept).

A Company Computer save shows a desktop notification, and the report goes into
the next tool result of the run holding that screen. (Amended 2026-09-28: the
report goes to the owner of the mount that saved, section 5; a `computer_shell`
command reports in its own tool result.)

### Errors that happen at once

These refusals happen as a file is opened or named:
- a path the authority may read but not write is mounted read-only
  (`EACCES`);
- adapter-only prefixes are refused: `.qorpera`, `.git`, `trail`, `inbox`,
  `credentials`, `secrets` and any `node_modules`. Code areas are the
  exception (section 6). (Amended 2026-09-27: `agents/*/instructions.md` and
  the retired `departments/*` prefixes are no longer refused; an agent's
  instructions are its `agents/<agent-name>/agent.md`, contract 5.6);
- deleting or moving a seeded folder or file is refused (`EPERM`): `vision/`,
  `vision/vision.md`, `agents/`, `agents/sections.md`, `agents/groups/`,
  `connections/`, `skills/` and `rules/`; the Co-Founder's folder and its
  `agent.md` cannot be deleted (contract 5.6);
- deleting an `agent.md` or a `group.md` on its own is refused (`EPERM`); the
  folder is deleted instead (contract 5.6);
- moving an agent's folder out of `agents/` or into `agents/groups/`, or a
  group's folder out of `agents/groups/`, is refused (`EPERM`) (contract 5.6);
- `rules/` is mounted read-only for agents (`EACCES`); only owners and admins
  write it (contract 5.6);
- names the Company File forbids are refused (`EINVAL`; under `code/`, git's
  rules apply instead, section 6): control characters,
  `:`, `%`, `\`, a trailing dot or space, device names with or without an
  extension (`con`, `con.txt`), names not in NFC, and names whose NFKC form
  contains `/`;
- a file over the size limit is refused (`EFBIG`).

Only conflicts, proposals and review outcomes wait for the boundary report.

## 3. Reads, the read set, and what the mount shows

### What the mount shows

- Exactly the paths the authority may read. Others do not exist (`ENOENT`),
  as in today's listings.
- Only files and folders:
  - symlinks, hard links, devices, FIFOs and sockets are refused (`EPERM`);
  - `chmod +x` sets the executable flag, and other mode bits are not kept;
  - everything is owned by the box's user;
  - a file's modification time is the time of its current version;
  - a name that differs only by case from an existing sibling fails with
    `EEXIST`.

### Read sets, by covering resource

A whole-company search must not turn into tens of thousands of per-path
rechecks. So the folder service records reads per run in two forms:

- **In SQL:** one row per authorizing resource and grant, with the oldest
  authority revision not yet rechecked (the core, §4). This is what is rechecked before each model
  request, send and mutation. Child wakes inherit these rows together with
  the parent's path lists.
- **As a compressed path list per command**, for audit and re-resolution. The
  list separates names (listed) from content (read). Since 2026-09-28 it is
  stored as one SQL row per command and covering resource (the core's read
  records, [RUNTIME-COMPANY-FOLDER-CORE.md](RUNTIME-COMPANY-FOLDER-CORE.md)
  §2), so SQL can re-resolve it and a whole-company search stays a few rows.

The recheck reruns the recorded paths under a resource when any of these
happens:
- a grant or resource covering something the run read changes;
- a new, narrower resource is created inside a covered subtree;
- the requesting member's role changes;
- the staff agent's employment status changes.

On a recheck:
- paths that are no longer readable leave the view;
- open handles on them fail with `EACCES`;
- when the run read their content, the run stops, as today's context
  authority stops it.

A revocation that covers nothing the run read does not touch the run.

### Tying output to reads

Each tool result names the read-record id of its command. That makes the
model-visible output traceable to the files it came from.

## 4. The run box

Each run gets a box of its own on the execution host, beside the harness's
box.

**Isolation.**
- The slot's host unit is unprivileged and cannot start a box as another
  account. A root-started unit per box, `qorpera-shared-box@N`, starts it
  instead, with its own memory, CPU and task limits outside the host unit's.
- The box runs as a third static account per slot, next to the host and
  runner accounts the installer already creates, with its own namespaces.
- It holds no credential files: no model login, service key or token.
- It has no network (founder decision 7).
- Home and `/tmp` are memory-backed and disappear when the run ends.

**Sizing.** Node 2's execution host is 4 vCPU and 8 GiB with two slots today
(`deploy/shared-execution/README.md`). Amended 2026-09-28:
- Since v144, a run whose login is in the vault no longer follows the
  login's home node. Logins move one at a time (contract, "2026-09-28
  amendment: model logins live in the vault").
- Node 1 has no execution host yet (`deploy/node-parity/README.md`). Until
  Identical Nodes gives it one, the run box exists on node 2 only.

Every execution host needs:
- the folder program unit (one per host, outside the slot units);
- the box unit and the third account per slot;
- more capacity: a box needs at least 1 vCPU and 2 GiB while its commands
  run.

This is a capacity decision made at step 2 (amended 2026-09-28; it was build
step 3), from measurements. The
limits are physical sizes; there is no cap on commands or run time.

**Working directory:** `/company`.

**Toolbox image:**
- bash and coreutils;
- ripgrep, fd and jq;
- Python 3 with pandas, openpyxl, python-docx and pypdf;
- Node;
- sqlite3, pandoc, poppler-utils and ImageMagick;
- LibreOffice headless;
- zip.

**Model tools.** New tools in the `qorpera` namespace, shaped like Codex's
own. Codex's built-in shell stays disabled, and the harness process never
runs a command.
- `exec_command`: a command, an optional working directory and a yield time.
  A command that is still running keeps going and is polled or fed with
  `write_stdin`.
- `apply_patch`: the Codex patch format, applied inside `/company`.

Long output keeps its head and tail, and the full output is saved in the
run's home.

**Review.** The box has no network, so its commands stay inside the company
and run at once. Only deletes, moves and delegation units are reviewed
(section 2, contract 5.6).

**Before writes are built.** Until step 3 (amended 2026-09-28; it was build
step 5) the mount is read-only.
Agents search and read through the shell and still write with today's tools.

**Retired after acceptance** (amended 2026-09-28: at the steps named):
- the five `company_*` tools, at step 3;
- the Company File realm of `computer_transfer`, at step 4.

**Workers.** A worker gets its own box, with the worker's authority.

## 5. Company Computers

**One view, company-wide.** Desktops on a Company Computer are workflow
surfaces, not security boundaries (section 12). So every mount on the machine
shows the same view: the company-wide view (amended 2026-09-28: a mount per
desktop and per shell command, for attribution; founder decision 2). That
view is the paths whose covering resource is the root shared resource (`path=''`, subtree,
company-wide), which the default agent grant targets
(`20260926035000_company_agent_default_write_grants.sql`).
Grants never inherit, so it excludes every path under a narrower resource, of
any scope, and hiring an agent never shrinks it. Screen admission checks that
the holding run's authority covers the machine view; a run whose default
grant was revoked or held back gets no Company Computer screen. Work on
narrower paths runs in the run box.

**Reads and writes are attributed per mount.** (Amended 2026-09-28.) Every
mount on a computer is a view with one owner, known by its pass and the
machine's vsock CID:
- **The desktop's mount** is bound into the desktop session: the file manager,
  applications and the desktop terminal. Its owner is the computer's holder:
  the run holding that screen, or the member while a member has taken it
  over. A takeover switches the view's holder.
- **Each `computer_shell` command's mount** is bound into that command's own
  mount namespace, inside the computer's shell namespace (#411). The network,
  `/tmp` and the process table stay shared. Its owner is the run that started
  the command, which #411 already records for each step. Later runs on the
  same computer start commands with mounts of their own. A member's takeover
  changes none of them. The view closes when the command and the background
  processes it started have ended.

Each mount's reads are recorded for its owner, and its changes are checked
against and recorded for its owner. The upload binding, the review and the
report follow the same owner.

This attribution is best effort between the shell commands of one computer.
They run as one user and share the process table, so one command can write
through another's mount (for example through `/proc/<pid>/root`). Every mount
on the machine shows the same company-wide view, so this can only misname who
saved, never widen what may be read or written.

When a screen passes to another run, later desktop saves belong to the new
holder. A computer with a running command stays in use, and its desktop is
closed before the seat changes hands (#409, item 1).

**The machine's own disk** holds only the system, installed applications,
browser profiles and caches. The rest is kept off it:
- desktop caches, thumbnails and autosave locations are memory-backed;
- swap is off;
- the desktop's Documents, Desktop and Downloads folders are the company
  folder;
- there is no trash on the mount: a file-manager delete is a real delete,
  which passes the automatic review;
- the workbench holds no work files.

**Shell.**
- `computer_shell` works in `/company`.
- The 15-second stop is replaced by long-running sessions like the run
  box's.
- It keeps the automatic review: since the compute amendment (#409, item 2)
  it has internet, so starting a command and typing into one are outside
  effects (amended 2026-09-28; this closes open question 2).

**Many machines.** A company's Company Computers all mount the same folder.
A save on one appears on the others within about a second.

## 6. Coding machines and code in the company folder

### The mount

A coding machine belongs to one member and carries that member's sessions.
Each session runs as its own uid. It sees the view of its run authority: the
paths both the coding agent and the member may use (contract section 4.3).

**Where the folder service runs.** Command units see only their own binds
(`deploy/coding-worker/COMMAND-GUEST.md`), and the guest holds no service
credential. The FUSE adapter therefore runs in the guest, one per attached
session. It talks over vsock to a folder service on the node host, and that
service holds the credentials. The mount is bound at `/company` in every
command unit of that session. The founder chose this over a third
hot-plugged virtiofs device on 2026-09-28. Command units get
`RestrictAddressFamilies` without `AF_VSOCK`, so a session's command cannot
reach the folder service itself. Under coding standby a session's view lives
as long as its attachment. Changes publish at command end, at git's commit
points and after a quiet period between turns, and once more before the
session is detached from its machine, sleeps or is archived.
`COMMAND-GUEST.md` is amended when this is built.

**Publishing.**
- Commands (`coding_run_command`) publish at the end of each command, using
  the run-box rule of section 2.
- Inside `.git` directories, publishing also happens at git's own commit
  points (see below).

**Review.** Coding sessions are not reviewed (2026-09-25 amendment, item 2).
Their deletes and moves, in `code/` and elsewhere, therefore apply without
the automatic review, and nothing a coding session does is ever partly
parked. Because of that, a coding session's mount shows `agents/` and
`rules/` read-only (contract 5.6): it cannot hire, create a group chat,
touch routines or rules, or archive an agent.

**What the session's own NAS folders keep:** the per-session cache (see
below) and custody.

### Layout

A repository lives at `code/<owner>/<name>/`, named after its GitHub owner and
name. It holds three things:
- `repo.git/`: the shared git directory, bare. It holds objects, branches and
  tags, and it is the only place other workers' changes can meet.
- `main/`: a worktree of the default branch that members read in the web app.
  Only the platform writes it, and it follows the default branch after each
  published update. Coding sessions see it read-only. It is marked with
  `git worktree lock` like the workers' worktrees.
- `worktrees/<workerId>/`: one linked worktree per coding worker, on the
  worker's fixed branch `qorpera/coding/<workerId>`, with its own git files in
  `repo.git/worktrees/<workerId>/`. The platform creates it the first time the
  worker runs and marks it with `git worktree lock`, so no one prunes it.

Rules for the whole repository:
- A repository and its worktrees stay under one covering resource, so no
  session sees a worktree whose git directory it cannot see.
- The platform seeds `repo.git` once, from the company's GitHub connection.
- The existing seed and export (`cloud-coding-git-guest.ts`) change to work
  through the shared git directory (git's `commondir`), not a private
  `<workspace>/.git`.
- Worktree links use absolute `/company` paths, which are the same on every
  machine.
- Branches still reach GitHub as pull requests (contract section 5.1): that
  is how code leaves the company, not how it is stored.

### Git on the mount

A session has exactly one worktree. Everything below is tied to the session,
never to a process id, because the folder service, across the vsock link,
cannot see the process (amended 2026-09-28; it was virtiofs).

**Where `.git` may be.**
- Today SQL refuses `.git` only as the first path segment, so `x/.git/…` is
  accepted.
- The new rule refuses `.git` or `repo.git` at any depth outside
  `code/<owner>/<name>/`, in SQL and in the folder service, and accepts them
  inside.

**Who may write what.**
- Only coding sessions may write a repository's `config` and hook scripts.
- Code in a repository runs in every coding session that works on it. A
  coding session can therefore make another session run code, through
  hooks, a hook path or an include, as any shared repository allows. Agents
  and members outside coding sessions cannot.
- The platform pins `core.fsmonitor=false` and `core.sshCommand` for every
  session.

**Two kinds of git files.**
- **The worker's own files.** Its worktree files, plus its git files in
  `repo.git/worktrees/<workerId>/` (`index`, `HEAD`, `ORIG_HEAD`,
  `MERGE_HEAD`, rebase state, its reflog). Only that worker's session and the
  platform may write or delete anything under `worktrees/<workerId>/` and
  `repo.git/worktrees/<workerId>/`. Everyone else reads them.
  - They publish together at the ordinary command end (section 2), and they
    never conflict.
  - Their lock files are ordinary local files: exclusive on that machine,
    never published, no lease.
  - A `checkout` or `reset --hard` that fails halfway leaves them exactly as
    git left them, and they publish at command end like any other change.
- **The shared files in `repo.git`.** Objects, `refs/`, `packed-refs`,
  `config`, `shallow` and their reflogs. Other workers write these too.

**The shared files follow git's lock protocol synchronously.** Git changes a
shared file by creating `X.lock` exclusively, writing it, and then renaming it
over `X` (or unlinking `X` and then removing the lock). The folder service
handles each step:
- **Exclusive create of `X.lock`** takes a lease in SQL for `X`.
  - Before `open()` returns, the folder service refreshes `X`, its reflog and
    `packed-refs` from the live folder, so git reads what is current.
  - While the lease is held, the lock file exists on every machine. Git
    elsewhere waits (refs and `packed-refs`, see the timeouts below) or fails
    with its usual "lock exists" message.
  - The lease is renewed while the session lives and ends when it detaches.
  - Git never holds a lock across commands. At each command end the folder
    service therefore drops any shared lease whose lock file is still there,
    for example from a git that was killed, and removes that lock.
- **Rename of `X.lock` over `X`** is the publish point, inside the syscall.
  - The unit is the session's pending objects, `X` and `X`'s reflog.
  - Objects always land, even when `X` conflicts; they are content-addressed.
  - `X` and its reflog are checked against their base versions. On a conflict
    the rename fails, so git reports an error instead of success, and git
    leaves the repository in its usual recoverable state.
  - A later `&& git push` in the same command line therefore never sees an
    unpublished commit.
- **Removal of `X.lock`** publishes `X`'s pending change, if there is one (a
  deleted branch from `branch -D`, `update-ref -d` or `fetch --prune`). It then
  drops the lease. An abort has no pending change and publishes nothing.
- **A rename onto a held lock** (a hook's `git add` using
  `GIT_INDEX_FILE=…/index.lock`) updates that lock and publishes nothing.

**Correctness rests on the version check at the rename.** The lease only
keeps writers from colliding. If a lease expires during a network break, the
version check still refuses the second writer.

**What a session may not touch.**
- A session cannot take a lease on another worker's branch
  (`refs/heads/qorpera/coding/<other>`), or on another worker's git files in
  `repo.git/worktrees/<other>/`.
- `refs/stash` is shared between all worktrees, so `git stash` is refused in
  shared repositories. Commit to your branch instead.
- A session cannot delete a published path under `repo.git/objects` (`EPERM`),
  and `objects/pack/*.keep` is never published.
- The `files` ref format is pinned; reftable is not used. A fetch that updates
  N refs means N synchronous publishes, which the spike measures.

**Settings every session runs with.** They are passed as
`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` in every command
unit, which outranks the repository's own config:

| Setting | Why |
|---|---|
| `core.filesRefLockTimeout=10000` and `core.packedRefsTimeout=10000` (ms) | git waits on a held ref or `packed-refs` lease rather than failing at once; other locks never retry in git |
| `gc.auto=0` and `maintenance.auto=false` | no automatic cleanup from a session |
| `gc.worktreePruneExpire=never` | `git gc` in a session never prunes a worktree; worktree locks also cover `git worktree prune` |
| `core.symlinks=false` | the Company File has no symlinks |
| `core.checkStat=minimal` and `core.trustctime=false` | git's index does not re-hash files because of how the mount reports file times |
| `core.splitIndex=false` and `index.sparse=false` | the index file always lists every path, so the folder service can read it (it also reads index version 4, which `feature.manyFiles` turns on) |

**File times.** A file the session wrote keeps, in that session's view, the
time the session wrote it until another version arrives. Publishing therefore
does not make the next `git status` re-hash the file and republish the index.

**Cleanup.**
- `git gc`, repacking and pruning run only as a platform maintenance job per
  repository. The job's host mounts the folder at `/company` too, so the
  worktrees' absolute links resolve there.
- The job blocks new leases in `repo.git` itself (not in workers' own git
  files) while it runs.
- Setting a file time (`utime`) on anything under `repo.git/objects` returns
  `EPERM`. Git then writes the object again instead of "freshening" it, so
  cleanup can never prune an object a commit is about to reference.
- Old versions of `repo.git/objects/**` (packs a repack replaced) are kept
  for 7 days, not forever. That is the one exception to "every change can be
  restored" (contract item 6). Restore works on worktree files and on refs,
  never on single object files.
- The history view shows a worktree's files and folds git's own changes into
  one line per publish.

**Git version.** The guest image, the seed and export helper, and the gc
job's host all run the same pinned git.

### The per-session cache

Dependencies and build output are caches, not company files. Each worktree
has a cache list:

- It starts from a fixed set of folder names: `node_modules`, `.venv`,
  `venv`, `target`, `dist`, `build`, `.next`, `.nuxt`, `__pycache__`,
  `.gradle`, `.cache`, `.turbo`, `.pytest_cache`, `coverage`.
- It drops any name under which the worktree's own index has entries. At each
  command end where that index changed, the folder service reads its paths
  (git's documented index format). A name that now has tracked files leaves
  the list, and the files at that name are published at the same boundary.
  This covers a worker that `git add`s files under `build/` on its own
  branch. A name that has left a worktree's list stays off it, so files that
  are already published never fall back into a cache.

Inside a worktree, a folder whose name is on the list lives in the session's
own NAS cache folder:
- It is never published.
- Other views and machines see nothing at that path.
- It can be rebuilt at any time.

Everything else in a worktree, including untracked output such as `out/` or
reports, is company data that members see. There is no ignore-pattern
matching in the folder service; `.gitignore` decides only what git commits.

### Names

Under `code/` the name rules follow git's, not the Company File's:
- `%`, `:` and device names (`aux.go`, `con.ts`) are allowed there.
- Two rules are kept, because they are the Company File's identity rules:
  - names are in NFC;
  - no two sibling names differ only by case.

The platform refuses to seed a repository that breaks either rule, and says
which paths are the problem. When a later fetch or checkout brings in such a
path, that git command fails on it and the report names it. The repository
stays usable, and the platform flags the branch.

### Sizes

A repository adds its tracked files and its `.git` files. This repository
alone is about 9,500 entries before any worktree. Code areas therefore come
after the version-per-file core and the lifted caps (build step 4 since
2026-09-27: the storage core's C1–C3). Pack files over 256 MiB need open
question 4.

## 7. Server work (SQL and gateway)

The storage core behind this section is designed in
[RUNTIME-COMPANY-FOLDER-CORE.md](RUNTIME-COMPANY-FOLDER-CORE.md) (2026-09-28).

1. **Change sets and units.**
   - One check and one commit cover many units, with an operation key.
   - Clean units share one commit (one sequence number).
   - Parked units wait on their card.
2. **Move and rename**, for files and whole subtrees, keeping each path's
   history. A copy is a write of the same content object, so it costs no
   bytes.
3. **Binary.** Byte-range reads of any content. Streamed chunk writes with no
   8 MiB export detour. The executable flag and media type are kept.
4. **Feed.** An authorized, cursor-based feed of file changes and authority
   changes per mount, woken by the company clock's Realtime hint
   ([the core](RUNTIME-COMPANY-FOLDER-CORE.md) §6).
5. **Read sets by covering resource** (section 3), with the recheck and wake
   inheritance moved to that form.
6. **Cost per change.** A change stops re-staging and re-verifying the whole
   tree: each path has its own version, so a commit's cost follows only its
   own units ([the core](RUNTIME-COMPANY-FOLDER-CORE.md) §3). The 8 MiB
   manifest cap and the 50,000-entry cap go with the manifest; the contract
   already calls such caps defects.
7. **Deletes and restore.**
   - An ordinary delete or move is a normal unit after the automatic review.
     Protected paths keep proposals.
   - Any earlier version of a path can be restored, by a member or by an
     agent.
8. **Upload binding** for the folder service (section 1).
9. **Code areas** (section 6):
   - the `.git` rule at any depth;
   - lock leases with refresh on grant, and synchronous publish at lock
     rename and lock removal;
   - the per-worker lease and stash refusals;
   - `repo.git/objects` delete refusal;
   - `.git/config` and hooks writable only by coding sessions;
   - relaxed names under `code/`;
   - `utime` refused under `.git/objects`;
   - `.git/objects` history retention;
   - the history view fold;
   - the per-repository gc job.

## 8. Security

**Credentials.**
- The harness box keeps the model login.
- The run box and the mounts have no credentials.
- The folder service's credentials never enter a box the model can reach.

**Authority.** It is enforced in the folder service at every lookup, read and
publish. Mount file modes are a convenience, not the boundary.

**Untrusted content.** File content is data. The run box has no network, so
its mount opens no new way out of the company. (Amended 2026-09-28: a
computer's shell and a test machine have internet, so company data read there
can leave, as the compute amendment accepts (contract, "2026-09-28
amendment: compute for agents", items 2 and 4, ratified). On a computer, a
firewall blocks private and special ranges, the machine itself and the other
computers; it is not a security boundary between agents. A test machine
reaches the internet but no private network, the NAS, the nodes or the
control plane. Starting a command and typing into one are outside effects
and pass the automatic review; on a test machine, once `/company` is
mounted.) The existing exits are connectors and the browser (both reviewed), and coding machines,
whose sessions keep open network and are not reviewed.
With the mount, company data a coding session reads can leave through that
network. The founder accepted this on 27 September so that coding agents can
work over company data; every read is still recorded, and every write still
passes the gateway.

**Paths.** The kernel resolves `..`, there are no symlinks, and the service
validates every path.

## 9. Build order

Amended 2026-09-28: the machine side now builds in the steps of
[Decided on 28 September 2026](#decided-on-28-september-2026). Old steps 1
and 4 are delivered by the storage core's slices (C1–C4, with C1f for the
feed), except restore in the web app, streamed binary writes and the upload
binding, which move to new step 3. The rest map to the new steps:
- old 2 is new 0 (the spike) and new 1;
- old 3 is new 2;
- old 5 is new 3;
- old 6 is new 4;
- old 7 with old 9 is new 5.

Test machines are the new step 6. The text below is kept for what each step
contains.

Everything runs on the release train, and every PR gets an independent review.
Reading comes first, so agents can search the whole company early. Writing
keeps using today's tools until old step 5 (new step 3).

Amended 2026-09-27 (contract, company folder layout amendment): the storage
core's version per file (formerly "per-folder trees") moves from step 8 into
step 4, and is designed in
[RUNTIME-COMPANY-FOLDER-CORE.md](RUNTIME-COMPANY-FOLDER-CORE.md). Its rollout
behind a per-company flag, the proof company and the reset are in that
document's §1 and §11. One head per company would make writes
through the mount conflict constantly, so the storage core changes before any
machine writes through the folder. Removing the company-wide lock for reads
moves into step 1, because steps 1–3 ship whole-company reads. The
structured-file saves, index updates and seeded-folder refusals of contract
5.6, and the clean reset of today's test companies, join step 4, before any
writes through the mount. Decision 6's automatic review of deletes and moves
is unchanged.

1. **Server, reading side.**
   - Reads stop taking a company-wide lock (moved here on 2026-09-27).
   - A run-authorized listing of a whole subtree.
   - Byte-range reads.
   - The feed.
   - Read sets by covering resource.
2. **Folder service and FUSE mount**, read-only, on an execution host: the
   unit, the account, and the `/dev/fuse` placement. Spike numbers come
   first. The spike also covers, on a real repository in the mount:
   - `git status`, `git commit`, `git fetch` and `git worktree add`;
   - memory-mapped pack reads;
   - lock contention between two machines;
   - names with `%`, `:` and device names.
3. **Run box.** `exec_command` over the read-only mount, the prompt change,
   and the capacity decision. First live acceptance: an agent searches the
   whole company.
4. **Server, writing side.**
   - A version per file with no head, lifting the manifest and entry caps
     (moved here from step 8; see
     [RUNTIME-COMPANY-FOLDER-CORE.md](RUNTIME-COMPANY-FOLDER-CORE.md)). Any
     per-folder summary is built after the commit.
   - Structured-file saves with their index update; the refusals for seeded
     folders, `rules/`, a lone `agent.md` or `group.md`, and agent or group
     folders moved out of place; and review by path for delegation units on
     every write path, including today's Company File tools (contract 5.6).
   - A clean reset instead of a migration (founder decision, 28 September
     2026): today's companies' data is deleted, their company state and
     indexes are cleared from Supabase, the company folder is set up on the
     NAS, and the layout is proven on new companies. The exact scope is
     confirmed with the founder before anything is deleted (contract, layout
     amendment).
   - Change sets and units.
   - Move and rename.
   - Streamed binary writes.
   - The delete policy of decision 6, with parked units; seeded folders are
     refused.
   - Restore, plus a file history view in the web app.
   - The upload binding.
5. **Writes through the mount.** Boundaries, reports, conflicts, proposals,
   reviewed deletes, moves and delegation units, and `apply_patch`.
6. **Company Computer mount.**
   - Per-desktop attribution.
   - Memory-backed caches.
   - Work files leave the workbench.
   - The `company_*` tools and the Company File realm of `computer_transfer`
     are retired.
7. **Coding-machine mount.**
   - The FUSE adapter in the guest with its vsock link (decided 2026-09-28;
     virtiofs was not chosen).
   - `/company` bound in every command unit.
   - Company data read, written and searched from coding sessions.
   - Coding sessions' changes skip review; `agents/` and `rules/` are
     read-only in them.
   - The repository stays in the session's private workspace until step 9.
8. *(Moved into step 4 on 2026-09-27.)*
9. **Code areas.**
   - The layout `code/<owner>/<name>/`, with `repo.git`, `main` and
     `worktrees/<workerId>`.
   - Seeding.
   - Seed and export through the shared git directory.
   - The session git settings.
   - The per-session cache.
   - Worktrees move from the private NAS workspace into `/company`.

## 10. Live acceptance

- **Search.** An agent runs `rg -l refund` over all of `/company` and opens
  what it found. The run's SQL read set stays a handful of rows.
- **Ordinary work.** Each of these lands as one commit per command, and
  members see it in the web app and its history:
  - `sed -i` on a document;
  - `mv reports/2026 archive/`;
  - `mkdir -p` for a new category folder;
  - a Python script that writes 200 CSV files.
- **Conflict.** Two agents edit the same file. The second gets a conflict
  report, and its version is kept on its receipt.
- **Protected.** Once a company configures a protected path (none is
  configured by default since 2026-09-27), a write under it becomes a
  proposal, and the mount shows the live content.
- **Company Computer.**
  - The file manager shows the same folder.
  - LibreOffice saves a document into it, and the lock file is never
    published.
  - A second Company Computer sees the save within about a second.
- **Coding.**
  - A coding agent searches company data from its session.
  - It creates a worktree under `code/`, commits, and opens a pull request.
  - A member sees the worktree's files in the web app.
  - `node_modules` never appears in the Company File.
  - Two sessions on different machines commit to the same repository at the
    same time. Neither corrupts it, and a conflicting ref update fails inside
    git before git reports success.
  - The gc job repacks while sessions work, and no commit is lost.
- **Credentials.** A probe from the run box finds no credential file.
- **Machine disks.** After a run, the disk and the workbench of each machine
  contain none of the company folder's content hashes. The one exception is a
  coding session's cache folders, which hold only dependencies and build
  output.

## Folders

An agent creates a folder when it needs a home for a category of files. It
never creates one to hold a single file; a single file goes into the existing
folder that fits. This wording ships ahead of the mount, in PR #366.

## Open questions

1. **Coding network.** Coding sessions keep open network (founder decision,
   27 September). A cheap mitigation that keeps coding working would be to
   limit coding machines to the sites coding needs: GitHub, package
   registries and the model providers. Not decided.
2. **Company Computer shell review.** Closed: it keeps the automatic review.
   The compute amendment (#409 item 2, ratified 2026-09-28) gives a
   computer's shell a network, so starting a command and typing into one are
   outside effects.
3. **Internet in the run box.** Founder decision 7 leaves this for later. If
   it opens, shell commands become outside effects and pass review.
4. **Large files.** Files over 256 MiB.
5. **Test machines used by several agents.** Settled by the compute
   amendment, item 4 (ratified 2026-09-28): any agent of the company may use
   a test machine, so it shows the company-wide view, like a company machine.
   Saves publish at each command's end and each time a running command's
   output is read, credited to the commands' agents, with overlapping
   commands listed; changes made with no command running go to the machine's
   starter at the next publish or at stop. Under root this attribution is
   best effort, and it can never widen the view.
