# The company folder on every machine

Status: design, not built. Founder decisions of 27 September 2026, recorded
in the contract as the 2026-09-27 amendment "every machine works in the
company folder" (section 19). This document is the design those decisions
refer to.

## Goal

The Company File is the company's whole folder: its full digital state, not
one file. Agents work in it exactly the way an agent works in the files of its
own computer. They list, search, read, edit, write, create folders, move,
rename, copy, delete and run scripts over it with ordinary tools.

The folder lives once, on the NAS. Machines are scalable compute that are
bolted onto it:

- agent run machines;
- Company Computers, however many a company has;
- coding machines.

Each machine mounts the same live folder at `/company`. File explorers show
that folder, and shells work in it. No machine keeps the company's files on
its own disk.

## What exists today (master 14baeadd7)

**Agent runs**
- Agents reach the folder only through five tools: `company_list`,
  `company_read`, `company_write`, `company_mkdir` and `company_delete`.
- A listing shows one level at a time, 50 entries per page.
- A read returns at most 4 KiB, and only UTF-8 text.
- A write replaces the whole file and holds at most 32 KiB of text.
- There is no search of any kind, no move and no rename.
- Every delete is a proposal that waits for a member.
- An agent run has no shell. Codex runs with `shell_tool` and `unified_exec`
  disabled and a read-only sandbox (`cloud-codex-tool-session.ts`). Its bwrap
  box holds `codex/auth.json`, the member's model login, so a shell there
  could read that login.

**Other machines**
- The Company Computer has a 15-second shell with no network. Its output is
  cut at 16 KiB, and it sees only the NAS workbench, not the Company File.
  Single files of up to 8 MiB move in and out one at a time through
  `computer_transfer`.
- The coding machine has a shell with commands of up to 30 minutes. It sees
  only the repository workspace, not the Company File.

**The mount that was retired**
The NFS live mount `/qorpera/company-live` (`e0b75fd04`, 26 August) was
retired on 29 August by `f0574bdf5` for two reasons:
- the shell sat next to the login;
- raw NFS writes bypassed versions, receipts and proposals.

This design keeps the mount and removes both reasons.

**Server**
- A change covers one path.
- Each change re-stages and re-verifies the whole tree and compare-and-swaps
  the global head. Writers race on `PT409` and retry.
- There is no move and no revision feed a client can read.
- Bytes are content-addressed objects on the NAS: 4 MiB chunks, 8 MiB
  objects, 256 MiB per file.
- A tree holds at most 50,000 entries and 1 TiB.

## The shape

```
                 NAS: the company folder (objects and versions, one place)
                      ▲ authorized reads             ▲ change sets
                      │                              │ (the mutation gateway)
          ┌───────────┴──────────────────────────────┴───────────┐
          │ folder service (trusted, one per machine)             │
          │ authority · read sets · presence · publish · reports  │
          └───────────┬───────────────────────┬──────────────────┘
                 /company                 /company              /company
          ┌───────────┴─────────┐  ┌──────────┴──────────┐  ┌────┴──────────┐
          │ run box (per run)   │  │ Company Computer(s) │  │ coding machine│
          │ shell + apply_patch │  │ file explorer,      │  │ beside the    │
          │ no logins, no net   │  │ terminal, apps      │  │ repository    │
          └─────────────────────┘  └─────────────────────┘  └───────────────┘

  model harness (Codex and the member's login): its own box, no mount, no shell
```

## 1. The folder service

The folder service is trusted. It runs outside every box the model can reach
and holds the machine's service credentials. There is one per machine. Each
mount is bound to exactly one authority:
- the run's authority (the agent plus the requesting member and the audience,
  as today's gateway computes it), or
- for a Company Computer screen, the run that holds the screen.

It is a new front on today's gateway, not a second authority. The same code
decides:
- path authority;
- receipts;
- presence;
- protected-path proposals;
- read-set recording, which is rechecked before model requests (sections 5
  and 9).

**What it serves:**
- whole-subtree authorized listings;
- attributes: size, time of the current version, and the executable flag;
- byte ranges of any content, text or binary;
- a feed of changes.

**What it accepts:** change sets (section 2).

**Kernel side.** A Linux FUSE filesystem. It is a thin adapter that talks
over a local socket to the TypeScript folder service. The adapter's language
(a maintained TypeScript binding, Rust `fuser` or Go `go-fuse`) is chosen in
PR 2 after a spike. The spike measures `rg` over 10,000 and 50,000 files on
node 2 against the real NAS.

**Caching.** Bytes stream from the NAS and are held only in memory: the kernel
page cache plus a bounded in-process cache keyed by content hash. Nothing of
the company folder is written to a machine's disk.

**Freshness.** The change feed invalidates changed paths. Another machine's
change is visible within about a second.

## 2. Writes: change sets

**When changes are published**
- **Shell.** At the end of every command. A long-running command also
  publishes whenever it yields output to the model, and after two quiet
  seconds.
- **Desktop applications.** When a saved file is closed or renamed into place,
  after a quiet period of one to two seconds.

**Where pending bytes live.** Written bytes stream straight to the NAS object
store as content-addressed chunks. They are not visible until published. The
machine holds at most the chunk that is still in flight, in memory.

**What gets published.** At each boundary the service computes the net change
per path:
- created;
- changed;
- deleted;
- moved. A rename inside the mount is a move.

A temporary file that is written and renamed over its target counts as a
change to the target, based on the target's version. A file that is created
and removed before the boundary never reaches the Company File.

**Versions.** Each path's base version is the version the box first saw
during that boundary.

**One revision.** The change set goes through the gateway as one path set
(section 5.1) and lands as one revision and one head move.

**Result per path.** Each path is checked on its own:
- **Clean paths** are committed together.
- **Conflict.** A path whose version moved is not written, so nobody's work
  is overwritten (no last-writer-wins). The box's version is kept in the run's
  private `~/.company-conflicts/`. The live file stays as it is.
- **Protected paths** become proposals. The mount keeps showing the live
  content until a member approves.
- **Deletes and moves** of ordinary paths pass the automatic review at publish
  time, and the reviewer sees the whole list. A declined delete or move is
  restored in the mount.

**The report.** Every command result ends with a short report of each changed
path: saved, waiting for approval, not applied (and why), or conflict (with
where the box's version is). A desktop save's report shows as a desktop
notification and is added to the run's next tool result.

**Errors that are immediate.** Static refusals happen as the file is opened:
- a path the authority may read but not write is mounted read-only
  (`EACCES`);
- adapter-only prefixes are refused: `.qorpera`, `.git`, `credentials`,
  `secrets`, `trail`, `inbox`, `node_modules` and agent instructions;
- names that are not allowed, and files over the size limit (`EFBIG`), are
  refused.

Only version conflicts, proposals and review outcomes wait for the boundary
report.

## 3. What the mount shows

**Visibility.**
- The mount shows exactly the paths the authority may read. Other paths do not
  exist (`ENOENT`), as in today's listings.
- Revoking authority mid-run removes those paths from the view. Open handles
  then fail with `EACCES`, and pending changes are checked again at publish.

**Kinds of entry.** Only files and folders exist.
- Symlinks, hard links, devices, FIFOs and sockets are refused (`EPERM`).
- `chmod +x` sets the executable flag. Other mode bits are not stored.
- Everything appears to be owned by the box's user.
- A file's modification time is the time of its current version.
- A name that differs only by case from an existing sibling fails with
  `EEXIST`. The gateway already refuses another spelling of an existing
  folder.

## 4. The run box

Each run gets a box of its own on the execution host, beside the harness's box.

**Isolation.**
- It has its own user, its own namespaces, and no credential files: no model
  login, service key or token.
- It has no network (founder decision 7).
- Home and `/tmp` are memory-backed and disappear when the run ends.
- Resource limits come from node 2's headroom. The proposal is 2 vCPU and
  4 GiB. The limits are physical sizes; there is no cap on commands or run
  time.

**Working directory:** `/company`.

**Toolbox image:**
- bash and coreutils;
- ripgrep, fd and jq;
- Python 3 with pandas, openpyxl, python-docx and pypdf;
- Node;
- sqlite3, pandoc, poppler-utils and ImageMagick;
- LibreOffice headless, for document and spreadsheet conversion;
- zip.

**Model tools.** They take the shape the harness was trained on:
- `exec_command`: a command, an optional working directory, and a yield time.
  A command that is still running keeps going and is polled or fed with
  `write_stdin`, like Codex's unified exec.
- `apply_patch`: the Codex patch format, applied inside `/company`.

Long output keeps its head and tail. The full output is saved in the run's
home.

**Review.** The box has no network, so its commands stay inside the company
and run at once. Only deletes and moves in a change set are reviewed (see
section 2).

**Before writes are built.** Until step 5 of the build order, the mount is
read-only. Agents search and read through the shell and still write with
today's tools.

**Retired after acceptance:**
- the five `company_*` tools;
- the Company File realm of `computer_transfer`.

**Workers.** A worker gets its own box, with the worker's authority.

## 5. Company Computers

**Mounts.** Every screen session mounts `/company` with the view of the run
that holds the screen.
- The file manager shows it as "Company".
- Terminals open in it.
- The browser saves downloads into the folder the agent chooses there.
- A screen with no run holding it has no mount (open question 3).

**The machine's own disk** holds only:
- the system;
- installed applications;
- browser profiles;
- caches.

The NAS workbench keeps those and no work files.

**Shell.**
- `computer_shell` works in `/company`.
- The 15-second limit is replaced by long-running sessions like the run
  box's.
- Output follows the run box's rules.

**Many machines.** A company's Company Computers all mount the same folder.
A save on one appears on the others within about a second.

**Desktop saves** follow the rules in section 2.

## 6. Coding machines

A coding session mounts `/company` with the session run's authority, beside
the repository workspace. Code and the coding agent can read company
documents and write results into the folder. Repositories themselves stay
branch-and-PR (section 5.1).

## 7. Server work (SQL and gateway)

1. **Path sets.** One check and one commit cover many paths. They produce one
   revision and one head move. Versions are checked per path, clean paths
   commit and conflicts are reported. The contract already names "atomic path
   set" (section 5.1); the SQL implements one path today.
2. **Move and rename.** They cover files and whole subtrees and keep each
   path's history. A copy is a write of the same content object, so it costs
   no bytes.
3. **Binary.** Reads of any bytes. Writes of any bytes as streamed chunks,
   with no 8 MiB export detour. The executable flag and media type are kept.
4. **Revision feed.** An authorized, cursor-based feed of changed paths per
   mount, woken by the existing Realtime head signal.
5. **Cost per change.** A change stops re-staging and re-verifying the whole
   tree. Per-folder tree manifests make its cost follow its depth rather than
   the tree's size. After that the 50,000-entry limit is lifted; the contract
   already calls such limits defects.
6. **Deletes and restore.**
   - An ordinary delete or move becomes a normal change after the automatic
     review. Protected paths keep proposals.
   - Any earlier version of a path can be restored, by a member or by an
     agent.
7. **Read sets.** The folder service records reads per run in batches, as
   the one-path tools do today.

## 8. Security

**Credentials.**
- The harness box keeps the model login.
- The run box and the mounts have no credentials.
- The folder service's credentials never enter a box the model can reach.

**Authority.** It is enforced in the folder service at every lookup, read and
publish. File modes on the mount are a convenience, not the boundary.

**Untrusted content.** File content is data. Without network in the run box,
the only ways out are the existing reviewed channels: connectors, the
browser and messages.

**Paths.** The kernel resolves `..`, there are no symlinks, and the service
validates every path.

## 9. Build order

Everything runs on the release train. Every PR gets an independent review.
Reading comes first, so agents can search the whole company early. Writing
keeps using today's tools until step 5.

1. **Server, reading side:**
   - a run-authorized listing of a whole subtree;
   - byte-range reads of any content;
   - the revision feed;
   - read sets recorded in batches.
2. **Folder service and FUSE mount**, read-only. Spike numbers first.
3. **Run box:** `exec_command` over the read-only mount, and the prompt
   change (see Folders). First live acceptance: an agent searches the whole
   company.
4. **Server, writing side:**
   - path sets;
   - move and rename;
   - streamed binary writes;
   - the delete policy of decision 6;
   - restore of earlier versions.
5. **Writes through the mount:** change sets, reports, conflicts, proposals,
   deletes through review, and `apply_patch`.
6. **Company Computer and coding-machine mounts.** Work files leave the
   workbench, and the `company_*` tools and the Company File realm of
   `computer_transfer` are retired.
7. **Per-folder trees** and lifting the entry limit.

## 10. Live acceptance

- **Search.** An agent runs `rg -l refund` over all of `/company` and opens
  what it found.
- **Ordinary work.** Each of these lands as one change per command, and
  members see it in the web app and its history:
  - `sed -i` on a document;
  - `mv reports/2026 archive/`;
  - `mkdir -p` for a new category folder;
  - a Python script that writes 200 CSV files.
- **Conflict.** Two agents edit the same file. The second gets a conflict
  report, and nothing is lost.
- **Protected.** A write under `finance/` becomes a proposal, and the mount
  shows the live content.
- **Company Computer.**
  - The file manager shows the same folder.
  - LibreOffice saves a document into it.
  - A second Company Computer sees the document within about a second.
- **Credentials.** A probe from the run box finds no credential file.
- **Machine disks.** A probe of every machine disk after a run finds nothing
  of the company folder.

## Folders

An agent creates a folder when it needs a home for a category of files. It
does not create one to hold a single file. A single file goes into the
existing folder that fits.

This rule replaces:
- the "do not add folders nobody requested" wording in the run instructions;
- the `COMPANY_FILE_PARENT_MISSING` hint that says to create the missing
  folder.

## Open questions

1. **Company Computer shell review.** The Company Computer shell has no
   network either. Should it also run without review once it touches only
   the mount and the machine? Proposed: yes.
2. **Internet in the run box.** Founder decision 7 leaves this for later. If
   it is opened, shell commands become outside effects and pass review.
3. **Screens with no run.** Should such a screen mount read-only on the
   agent's own grants, or not mount at all? Proposed: not at all.
4. **Large files.** Files over 256 MiB.
