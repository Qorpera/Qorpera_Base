# The company folder on every machine

Status: design, not built. Founder decisions of 27 September 2026 are recorded
in the contract as the 2026-09-27 amendment "every machine works in the
company folder" (section 19). The founder's later decision the same day, that
coding machines mount the folder too and keep repositories and worktrees in
it, is part of that amendment. This document is the design those decisions
refer to.

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

**The coding machine** has a shell with commands of up to 30 minutes and open
network egress. Sessions are not reviewed, and it sees only the repository
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

## 1. The folder service

**What it is.** A trusted service that runs outside every box the model can
reach and holds the machine's service credentials. It is a new front on
today's gateway, not a second authority: the same code decides path
authority, receipts, presence and protected-path proposals.

**Where it runs.**
- **On an execution host:** a host-level unit per slot, beside the slot's
  host unit. It holds `/dev/fuse` and mounts with `allow_other` before the
  run box starts, and bwrap bind-mounts that mount into the box. The slot unit
  itself stays unprivileged.
- **On a Company Computer:** a system unit.
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
TypeScript folder service over a local socket. The adapter's language (a
maintained TypeScript binding, Rust `fuser` or Go `go-fuse`) is chosen in
build step 2, after a spike on node 2 against the real NAS. The spike measures
`rg` over a tree at today's real limit (about 27,000 files) and over a
synthetic 50,000-file tree.

**Caching.** Bytes stream from the NAS and are held only in memory: the kernel
page cache plus a bounded in-process cache keyed by content hash. Nothing of
the company folder is written to a machine's disk.

**Freshness.** The feed invalidates changed paths, so another machine's
change is visible within about a second. Grant and resource changes also
arrive on the feed: they reload the view and trigger the recheck in section 3.

**Uploads.** Today's upload binding belongs to a Codex run lease
(`object-gateway/src/native-objects.ts`), and its check has no path. The
folder service gets its own binding: run-scoped on an execution host,
screen-holder-scoped on a Company Computer. The path is still checked at
commit. Memory holds at most one partial chunk per open file.

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
Everything pending since the last boundary is lost if the service dies:
paths, bytes and moves. The run's next tool result reports it as "not
applied: the folder service restarted".

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

All clean units of a boundary land in one revision and one head move.

### The outcome of each unit

- **Clean.** It is committed in that revision.
- **Conflict.** A base version moved, so the unit is not written; nobody's
  work is overwritten (no last-writer-wins). The run's version is kept as an
  immutable object on the run's receipt. It is shown read-only in the box
  under `~/conflicts/` and can be restored from the receipt after the run.
- **Protected.** The unit becomes a proposal and waits for a member.
- **Delete or move of an ordinary path.** All such units of the boundary go
  to the automatic review together, as one reviewed action that lists them
  all (2026-09-25 amendment). The folder service asks the harness host of the
  run that made the change; a Company Computer reaches it through that screen
  holder's run.
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
the next tool result of the run holding that screen.

### Errors that happen at once

These refusals happen as a file is opened or named:
- a path the authority may read but not write is mounted read-only
  (`EACCES`);
- adapter-only prefixes are refused: `.qorpera`, `.git`, `trail`, `inbox`,
  `credentials`, `secrets`, any `node_modules`, `agents/*/instructions.md`,
  and `departments/*/repository` and `departments/*/worktrees`;
- names the Company File forbids are refused (`EINVAL`): control characters,
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

- **In SQL:** one row per authorizing resource and grant, with the newest
  authority version seen. This is what is rechecked before each model
  request, send and mutation. Child wakes inherit these rows together with
  the parent's path lists.
- **As a compressed path list per command**, stored as an object on the run
  for audit. The list separates names (listed) from content (read).

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
(`deploy/shared-execution/README.md`). Runs execute on the execution host of
the member's identity-home node. Every such host therefore needs:
- the per-slot folder service unit;
- the box unit and the third account per slot;
- more capacity: a box needs at least 1 vCPU and 2 GiB while its commands
  run.

This is a capacity decision made at build step 3, from measurements. The
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
and run at once. Only deletes and moves are reviewed (section 2).

**Before writes are built.** Until build step 5 the mount is read-only.
Agents search and read through the shell and still write with today's tools.

**Retired after acceptance:**
- the five `company_*` tools;
- the Company File realm of `computer_transfer`.

**Workers.** A worker gets its own box, with the worker's authority.

## 5. Company Computers

**One view per machine.** Desktops on a Company Computer are workflow
surfaces, not security boundaries (section 12). So the machine mounts one
view: the company-wide view. That view is the paths whose covering resource is
the root shared resource (`path=''`, subtree, company-wide), which the default
agent grant targets (`20260926035000_company_agent_default_write_grants.sql`).
Grants never inherit, so it excludes every path under a narrower resource, of
any scope, and hiring an agent never shrinks it. Screen admission checks that
the holding run's authority covers the machine view; a run whose default
grant was revoked or held back gets no Company Computer screen. Work on
narrower paths runs in the run box.

**Reads and writes are attributed per desktop.** The folder service tells
desktops apart through a mount namespace per desktop. A desktop's reads are
recorded in the read set of the run holding that screen. Its changes are
checked against, and recorded for:
- the run holding that screen; or
- the member, while a member has taken the screen over.

When a screen passes to another run, later saves belong to the new holder.

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
- It keeps its current review status (open question 2).

**Many machines.** A company's Company Computers all mount the same folder.
A save on one appears on the others within about a second.

## 6. Coding machines and code in the company folder

**The mount.** A coding machine belongs to one member and carries that
member's sessions. Each session runs as its own uid and gets its own mount
namespace, holding the view of the session's run authority: the coding agent
plus the member.

- Coding agents read, search and write company data like any agent. Their
  commands (`coding_run_command`) publish at the end of each command, using
  the run-box rule of section 2.
- The session's working directory is its worktree inside `/company`.
- The coding machine's existing NAS session folders keep only machine-local
  data (see below) and custody.

**Repositories and worktrees live in the company folder.**
- A repository is a folder under `code/`, for example `code/<repo>/`, with
  its `.git` inside it.
- Coding agents create worktrees there with ordinary git (`git worktree add`)
  and keep them as company files, for example under
  `code/<repo>-worktrees/<branch>/`.
- Members see the code and its history in the web app like any other part of
  the company.
- Branches still reach GitHub as pull requests (contract section 5.1): that
  is how code leaves the company, not how it is stored.

**What changes for git.**
- **Git metadata is allowed in `code/`.** Today `.git` is an adapter-only
  prefix and generic writes are refused. Under `code/` the gateway accepts
  `.git` directories and git's own files, and the mount shows them like any
  file. Everywhere else `.git` stays refused.
- **Git's lock files are real locks across machines.** Git takes
  `index.lock`, `HEAD.lock`, `packed-refs.lock` and the like by creating them
  exclusively. Inside a `.git` directory, the folder service turns an
  exclusive create of a `*.lock` name into a short-lived lease in SQL. Two
  machines therefore cannot both hold it. Lock files are never published.
- **One git command is one unit.** Everything a git command changes inside
  one `.git` directory (objects, refs, index, logs) is one unit and lands
  whole or not at all. A ref that moved on another machine makes the unit a
  conflict: nothing is written and the command's report says so. Objects are
  content-addressed, so they never conflict.
- **Git's housekeeping stays out of the history view.** `.git` internals are
  versioned like any file. The web app's history view shows the worktree's
  files and folds `.git` changes into one line per command.

**Machine-local data.** Dependencies and build output are machine caches,
not company files:
- `node_modules` always;
- anything the repository's `.gitignore` ignores, by git's own
  `check-ignore` rules.

These live on the session's NAS folder on the coding machine and are shown at
their place inside the worktree. They are never published, and they can be
rebuilt at any time. This keeps a repository's company footprint at the size
of its source and history, and it matches today's rule that `node_modules`
never enters the Company File. Everything else in a worktree, including
untracked files git does not ignore, is company data.

**Sizes.** A repository adds its tracked files plus its `.git` files. Large
repositories need per-folder trees and the lifted caps (build step 8). Pack
files over 256 MiB need open question 4.

## 7. Server work (SQL and gateway)

1. **Change sets and units.**
   - One check and one commit cover many units, with an operation key.
   - Clean units share one revision.
   - Parked units wait on their card.
2. **Move and rename**, for files and whole subtrees, keeping each path's
   history. A copy is a write of the same content object, so it costs no
   bytes.
3. **Binary.** Byte-range reads of any content. Streamed chunk writes with no
   8 MiB export detour. The executable flag and media type are kept.
4. **Feed.** An authorized, cursor-based feed of file changes and authority
   changes per mount, woken by the existing Realtime head signal.
5. **Read sets by covering resource** (section 3), with the recheck and wake
   inheritance moved to that form.
6. **Cost per change.** A change stops re-staging and re-verifying the whole
   tree: per-folder tree manifests make its cost follow its depth. After that
   the 8 MiB manifest cap and the 50,000-entry cap are lifted; the contract
   already calls such caps defects.
7. **Deletes and restore.**
   - An ordinary delete or move is a normal unit after the automatic review.
     Protected paths keep proposals.
   - Any earlier version of a path can be restored, by a member or by an
     agent.
8. **Upload binding** for the folder service (section 1).
9. **Code areas** (section 6): `.git` accepted under `code/`, lock leases,
   one unit per git command, and `.git` folded in the history view.

## 8. Security

**Credentials.**
- The harness box keeps the model login.
- The run box and the mounts have no credentials.
- The folder service's credentials never enter a box the model can reach.

**Authority.** It is enforced in the folder service at every lookup, read and
publish. Mount file modes are a convenience, not the boundary.

**Untrusted content.** File content is data. The run box and the Company
Computer shell have no network, so the mount opens no new way out of the
company. The existing exits are connectors and the browser (both reviewed),
and coding machines, whose sessions keep open network and are not reviewed.
With the mount, company data a coding session reads can leave through that
network. The founder accepted this on 27 September so that coding agents can
work over company data; every read is still recorded, and every write still
passes the gateway.

**Paths.** The kernel resolves `..`, there are no symlinks, and the service
validates every path.

## 9. Build order

Everything runs on the release train, and every PR gets an independent review.
Reading comes first, so agents can search the whole company early. Writing
keeps using today's tools until step 5.

1. **Server, reading side.**
   - A run-authorized listing of a whole subtree.
   - Byte-range reads.
   - The feed.
   - Read sets by covering resource.
2. **Folder service and FUSE mount**, read-only, on an execution host: the
   unit, the account, and the `/dev/fuse` placement. Spike numbers come
   first, and the spike includes `git status`, `git commit` and
   `git worktree add` on a real repository in the mount.
3. **Run box.** `exec_command` over the read-only mount, the prompt change,
   and the capacity decision. First live acceptance: an agent searches the
   whole company.
4. **Server, writing side.**
   - Change sets and units.
   - Move and rename.
   - Streamed binary writes.
   - The delete policy of decision 6, with parked units.
   - Restore, plus a file history view in the web app.
   - The upload binding.
5. **Writes through the mount.** Boundaries, reports, conflicts, proposals,
   reviewed deletes and moves, and `apply_patch`.
6. **Company Computer mount.**
   - Per-desktop attribution.
   - Memory-backed caches.
   - Work files leave the workbench.
   - The `company_*` tools and the Company File realm of `computer_transfer`
     are retired.
7. **Coding-machine mount.**
   - Per-session mount namespaces with the session's authority.
   - Worktrees in `/company`.
   - Machine-local dependencies and build output on the session folder.
8. **Per-folder trees**, and lifting the manifest and entry caps.
9. **Code areas.**
   - `.git` under `code/`.
   - Lock leases.
   - Git commands as units.
   - The history view fold.
   - A coding session moves its repository from its private NAS workspace
     into `code/`.

## 10. Live acceptance

- **Search.** An agent runs `rg -l refund` over all of `/company` and opens
  what it found. The run's SQL read set stays a handful of rows.
- **Ordinary work.** Each of these lands as one revision per command, and
  members see it in the web app and its history:
  - `sed -i` on a document;
  - `mv reports/2026 archive/`;
  - `mkdir -p` for a new category folder;
  - a Python script that writes 200 CSV files.
- **Conflict.** Two agents edit the same file. The second gets a conflict
  report, and its version is kept on its receipt.
- **Protected.** A write under `finance/` becomes a proposal, and the mount
  shows the live content.
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
  - Two sessions on different machines commit to the same repository, and
    neither corrupts it.
- **Credentials.** A probe from the run box finds no credential file.
- **Machine disks.** After a run, the disk and the workbench of each machine
  contain none of the company folder's content hashes.

## Folders

An agent creates a folder when it needs a home for a category of files. It
never creates one to hold a single file; a single file goes into the existing
folder that fits. This wording ships ahead of the mount, in PR #366.

## Open questions

1. **Coding network.** Coding sessions keep open network (founder decision,
   27 September). A cheap mitigation that keeps coding working would be to
   limit coding machines to the sites coding needs: GitHub, package
   registries and the model providers. Not decided.
2. **Company Computer shell review.** Its shell has no network either. Should
   it run without review once it touches only the mount and the machine?
   Proposed: yes.
3. **Internet in the run box.** Founder decision 7 leaves this for later. If
   it opens, shell commands become outside effects and pass review.
4. **Large files.** Files over 256 MiB.
