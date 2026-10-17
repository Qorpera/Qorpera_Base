# Coding machines on the folder (F3 step 5): the plan

Status: plan, for review before it is built. No slice is built yet.
The design it follows is [RUNTIME-COMPANY-FOLDER.md](RUNTIME-COMPANY-FOLDER.md) §6 ("Coding sessions": the mount, the
layout, who may write what, the lock protocol, the cache list) and §7 item 9, and its build order (step 5), with the
contract's 2026-10-14 amendment ("machines work in the folder as on their own disk"), item 11 ("Coding machines work
like a cloud coding machine") and its "For the build" paragraph. The views are C1b-3's
([RUNTIME-COMPANY-FOLDER-C1B.md](RUNTIME-COMPANY-FOLDER-C1B.md) §1–§9; coding views §3, §5, §6). It reuses step 4's
mechanics ([RUNTIME-FOLDER-COMPANY-MACHINES.md](RUNTIME-FOLDER-COMPANY-MACHINES.md): the serving check, the boundary
answer, the reasons, the mount propagation proof), the agent exit
([RUNTIME-AGENT-EXIT.md](RUNTIME-AGENT-EXIT.md)) and W6's machine rule (the coordinator's agreed W6 design, built in
W6a #986: `qorpera_memory_run_machine_narrow` and `qorpera_coding_turn_mark_narrow`). Where this page differs from
them, it says so and why. Links in the folder are [RUNTIME-FOLDER-LINKS.md](RUNTIME-FOLDER-LINKS.md)'s. Facts about
today's coding machines are from master at dc4988f7a.

> **Scope reset, 2026-10-17.** Jonas narrowed the rebuild on 17 October 2026: see the
> [scope amendment](../../QORPERA-REBUILD-SCOPE-AMENDMENT-2026-10-17.md), §3, and the contract's
> [2026-10-17 amendment](../../QORPERA-RUNTIME-CONTRACT.md#2026-10-17-amendment-the-rebuilds-scope-founder-correction),
> item 3. Where this plan says otherwise, the amendment wins. For step 5:
> - **deferred, outside core acceptance:** the rest of 5h (the setup file's automation, the builder VM and
>   snapshots), 5i (previews, their proxy and the agent's browser), and support for other setup systems (Cursor's
>   file, devcontainers) beyond what core execution needs. The merged setup parser and snapshot records (#1100 and
>   #1131) stay, unused; nothing is removed or undone for this. A coding machine with no setup is the accepted
>   core baseline, and ordinary package installs stay;
> - **deferred as well, on the coordinator's list of deferred work of 17 October:** MCP servers inside coding
>   sessions and the vault relay (5j-6c, the host's forwarder; 5j-6d, the full URL form; 5j-7, sign-ins and their
>   proof; the VM's vsock relay and git's `insteadOf`), and the 5m live proof run (the note under 5m's proofs). The
>   broker routes already merged for the relay (5j-6b, #1266) stay, unused;
> - **parked:** 5k (a second machine when one is full), which is capacity work, and 5l (the retirements after
>   step 6), both on that list. Their unmerged work is kept;
> - **kept:** machine and coding execution, folder access, root and Docker, code custody (a push and its pull
>   request keep their credentials), vault secrets in coding commands, masked in output and refused in a save into
>   the folder or a push (5j-4, 5j-5), credential handling, connectors, persistence, recovery and access control.
>   The CPU and byte measurements that idle sleep and quiet-day archival need are core.
>
> The places below that serve only deferred or parked work carry a mark. The status line above dates from the
> plan's review. This note records scope; it says nothing about which slices are built.

## What step 5 delivers

Every coding session works in the company folder at `/company`, on a machine that works like a cloud coding machine
(item 11): any language, root through `sudo`, Docker and compose, a setup file that builds a snapshot, terminals the
member watches, ports the member opens from the web app, a browser the agent drives, secrets from the vault as
environment variables, MCP servers as programs, and a second machine when one is full. A session's repository is the
code area's shared git directory (§6 layout): its worktree is `code/<owner>/<name>/worktrees/<workerId>/` on the branch
`qorpera/coding/<workerId>`, and its branch leaves only as a pull request. The private repository folder, its seed and
export chain and the 64 MiB bundle retire (build order row 5).

What does not change (item 11, "What stays"): the network goes through the agent exit under company rules; coding
sessions are unreviewed; each session mounts with its own authority; a branch leaves only as a pull request.

**Root is the member's own.** The machine belongs to one member, and root reaches only that member's own sessions
(item 11). So nothing that must hold for the platform, for another member or for another company runs inside the
machine: the folder's checks, receipts, logs, the lease, sign-ins and git custody all stay outside it (below). Inside
the machine, the walls between one member's sessions keep order, not security; root removes them ("For the build": a
save is credited to its session as well as root allows, as on test machines).

## The parts

- **The coding machine**: one LXD VM per member, coding agent, repository and setup digest (below, and Q1), in the
  LXD project for coding machines (Q8). Its only NIC is on the agent plug (`agentPlugCard("eth0")`, as today in
  `coding-machine.ts:148`), so all its traffic leaves through the agent exit. Its disk keeps home, caches, Docker and
  tmp across sleep.
- **The guest agent** (`qorpera-guest`, new, replacing today's command helper and storage helper): runs as root in the
  VM and is untrusted. The executor drives it only by LXD exec, which the host starts. Its answers are observations;
  the executor's journal and SQL are the truth.
- **The folder program**: step 1's FUSE program, one per session, as root in the VM, at
  `/run/qorpera-folder/mounts/<worker32>` and bound at `/company` in each of the session's units.
- **The node's folder service**: step 1–4's service on the node host. It serves coding views to the machine they belong
  to, records each read it serves, releases reads, publishes saves and answers boundaries.
- **The executor** (`coding-executor-host.ts`): opens and renews views, starts commands, writes receipts and output
  host-side, holds the lease, injects environment secrets and asks for boundaries over a host-local control socket.
- **The code host** (new, 5e): a credential-free platform VM with no NIC, one per company on each node, that runs every
  git command that must not run as a member's root: the seed, worktree adds, the default branch's `main/`, the export
  bundle, gc, and reading the setup file.
- **The builder VM** (new, 5h): a fresh VM per snapshot build, on the agent plug, with no `/company`.
- **The preview proxy** (new, 5i) and **the vault relay** (new, 5j), both host-side.
- **The host watchdog** (new, 5g): a host timer that force-stops a coding VM whose lease has lapsed.

> **Scope reset, 2026-10-17.** The builder VM (5h), the preview proxy (5i) and the vault relay (5j-6c to 5j-7) are
> deferred (the note at the top).

## Capabilities on our nodes

Each capability of item 11, and how it works on our nodes. "The VM" is the member's coding machine.

| Item 11 | On our nodes | Slice |
| --- | --- | --- |
| Any language | The base image carries the common toolchains; the setup file installs the rest. The VM has its own kernel, so any userland runs. | 5f, 5h |
| Root through `sudo` | Each session's uid has NOPASSWD sudo in the VM. Root is the VM's root under KVM; it reaches the host only through the channels in "The security line". | 5f, 5g |
| Docker and compose | Rootless Docker per session in the VM (`/run/user/<uid>/docker.sock`), started on first use; `sudo docker` reaches the system daemon. Nested containers stay in the guest kernel. | 5f |
| A setup file | Ours (`.qorpera/environment.json`), then `.cursor/environment.json`, then `.devcontainer/devcontainer.json`, read host-side by the code host and parsed by the executor under a strict schema. | 5h |
| Snapshots | Per member, repository and setup digest, built on a fresh builder VM from the default branch; a failed build keeps the old snapshot; a snapshot is scratch. | 5h |
| Terminals the member watches | tmux per session in the VM, streamed to the web app over host-initiated exec. | 5g |
| Ports opened from the web app | A node preview proxy on a preview domain reaches the session's port through a host-initiated stream. | 5i |
| A browser the agent drives, with screenshots | Headless Chromium in the session's network namespace, driven by a `coding_browser` tool; a boundary before each screenshot reaches the model. | 5i |
| Secrets as environment variables | Vault environment secrets, scoped to the member or the company, injected host-side into each command; masked in output, logs, receipts, saves and pushes (Q4). | 5j |
| MCP servers as programs | They run as programs in the VM and reach the harness through host-initiated stdio streams; their sign-ins go through the vault relay. | 5j |
| No waiting: a second machine | When the machine is full, a new attach opens the member's next machine for the same agent, repository and setup digest (Q9). | 5k |
| The network through the exit | The VM's only NIC is on the agent plug; the agent exit applies company rules and refuses our own networks (agent exit §3). | today |
| Unreviewed sessions | Coding views commit without review, as today (C1b-3 §2). | 5a |
| Each session mounts with its own authority | One view per session, served only to its own machine (below). | 5a, 5c, 5g |
| Branches leave only as PRs | The code host bundles the session's branch; the broker checks and pushes it and opens a draft PR. | 5e |

> **Scope reset, 2026-10-17.** The rows for a setup file and snapshots (5h), for ports and the browser (5i) and for
> MCP servers (5j-6c to 5j-7) are deferred, and the second machine (5k) is parked (the note at the top). The secrets
> row stays core (5j-4, 5j-5). "Any language" holds through the base image and ordinary package installs; its setup
> file part is deferred.

## What stays outside the machine

Root in the VM can't be trusted for anything that must hold beyond the member's own sessions. Everything below runs on
the node host, in the code host or in the broker, and the VM sees only its results.

| What | Where it runs | Why it can't be in the VM |
| --- | --- | --- |
| The folder's checks: authority, the code area rules, leases, names, sizes, the masking scan | The node's folder service and the core | Root can change any program in the VM. |
| The read record and release | The folder service records each read it serves, in memory, before the answer leaves | A guest-kept read log could be edited. |
| Receipts, `output.log` and read pages | Written host-side by the executor into the worker's NAS custody folder, masked first | The VM never sees the custody folder, so root can't rewrite history. |
| The lease | The executor's lease file and the host watchdog | A guest watchdog can be switched off. The guest's `qorpera-coding-watchdog` stays only as a courtesy. |
| Sign-ins (AI, GitHub, MCP) | AI sign-ins on the execution host; the GitHub token in the broker; MCP sign-ins in the vault relay | Root reads every file and environment in the VM. |
| Git custody: seed, `main/`, export, gc, config and hooks of record | The code host and the broker | A hook or config include would run as another member's root, with their secrets (below). |
| Today's trusted helpers in the guest: the command helper and the storage helper (COMMAND-GUEST.md) | Retired. Their work moves to the executor (receipts, output, the lease) and the code host (git); what is left in the VM is the untrusted guest agent | Root can replace a pinned helper after the executor checked it, and the NAS data and custody folders they served leave the VM. |
| The self-update refusal (`RUNNER_IMAGE_SELF_UPDATE_ENABLED`) and the helper pins | Retired as checks: root may install anything | They were walls against the session's own user. The image build still masks the apt timers and unattended-upgrades, and `imageFingerprint` stays as the image's identity. |

## The security line

**What a member's root reaches.** Its own VM: every session, file, process, environment, pass and mount on it. The
folder only through the views served to that VM, so never more than the coding agent ∩ the member (below). The network
only through the agent exit, under company rules, with our own networks refused (the guest guard's `internal4` set and
our public addresses, agent exit §3) and the exit's port isolation between guests. Two host services on vsock, each of
which checks the caller's CID against the VM it serves: the folder service (step 1's listener) and the vault relay
(5j). LXD's own agent channel, which is LXD's boundary and runs only what the host starts. The secrets the member
and the company gave it (5j).

**What it can't reach:**

- **Other members.** Each member has their own VMs. No host filesystem is shared: the NAS data and custody disks leave
  the guest, and the machine's disk is its own. Views are served per machine, so a pass read on one VM fails on any
  other. Git files that run code (`repo.git/config`, `hooks/**`, `info/**`, a worktree's `config.worktree`) are kept per
  session and never published, so nothing one member's root writes runs in another member's VM (below).
- **The node host.** The VM is a KVM guest. The host listens to it only on the two CID-checked vsock services; every
  stream into the VM (exec, terminals, previews, MCP stdio) is started by the host. The host watchdog and the lease file
  are on the host. `security.devlxd=false` on coding machines (proved in 5f), so `/dev/lxd` offers the guest nothing.
- **Platform keys.** No service-role key in the guest (G2). The GitHub token stays in the broker; AI sign-ins stay on
  the execution host; MCP sign-ins stay in the vault relay. No secret or pass goes into LXD config, `user.*` keys or
  cloud-init: they reach the guest only over exec stdin.
- **Other companies.** A VM belongs to one company, environment and member; its views are the company's; the exit's
  company rules and log are per company (agent exit: a member sees only their own coding machine's lines).

**What never changes on node hosts.** No kernel modules, sysctls or nft changes; the guest guard is unchanged, and the
coding project's NIC is the agent plug it already guards. Nested Docker, BuildKit, devcontainer features and
`initializeCommand` all run in a VM (the member's machine or a builder VM), never on a host. A capability the guest
kernel needs is a base image change (5f), proved on a throwaway nested VM.

**Root inside the VM is accepted, not walled.** One member's sessions on one machine can read and change each other's
files, passes and mounts. A save is credited to its session as well as root allows ("For the build"). Root can misname
the saver among its machine's sessions, but never widen what the machine may read or change, because every view on the
machine has the same authority (below).

## Views and machines

**Which sessions share a machine.** A coding machine holds one member's sessions for one coding agent, one repository
and one setup digest (Q1). Every view on it then has the same authority: the coding agent ∩ the member, with `agents/`
and `rules/` read-only (contract 5.6; C1b's actor rule). Root can read every pass and mount on its machine, so a machine
that mixed agents would let one agent read through another agent's view, which breaks item 11's "each session mounts
with its own authority". One repository per machine is item 11's "the repository's machine": the setup file sets it up
and its snapshot is built from that repository (below). A session whose setup names `repositoryDependencies` uses its
own repository's machine. Jonas's "one machine per member" (24 September 2026) still holds per agent and repository: a
member who uses one coding agent on one repository has one machine. The machine's row keeps today's shape
(`qorpera_coding_machines`, kind `member`); 5a adds `staff_agent_id`, `repository` (the code area's `<owner>/<name>`),
`setup_digest` and `number` to it and widens the unique index `qorpera_coding_machines_current` from `(profile_id,
environment_id, member_user_id)` to those seven columns (still where `kind = 'member' and removed_at is null`). `number`
is the machine's place when one is full (5k). The LXD name stays `qorpera-coding-machine-<machine_id hex>`
(`lxdCodingMachineName`, `coding-machine.ts:78`).

**The setup digest** is the SHA-256 of the parsed setup file in its normal form together with the bytes of each
Dockerfile it names (`build.dockerfile`, devcontainer `dockerFile` and `build.dockerfile`), read from the default
branch, or of the empty setup when the repository has none (5h). A session whose repository's setup or Dockerfile
changes keeps its machine until it is archived; its next new session goes to the machine of the new digest. Other inputs
(a Dockerfile's context, the scripts `install` runs) are not in the digest, because the snapshot is only a head start:
every session is set up from its own checkout at attach (`install` runs again, and a Dockerfile setup's image is built
again from the session's worktree, quickly from the snapshot's BuildKit cache). An older disk can keep leftovers of an
older install, as a laptop does, but each session runs what its own checkout sets up.

**The view.** Each attached session has one open coding view (C1b-3 §3; the unique index
`qorpera_folder_views_open_coding` on `(worker_id) where state='open'`). The executor opens it after the attach
commits, in its own transaction (C1b-3 §5), with the opener `{"kind":"platform"}` and the anchor `{workerId,
attachmentToken}`. `qorpera_folder_view_open` already finds the machine through the allocation whose
`coding_machine_id` is the session's `attached_machine_id`, so the view's `machine_id` is the coding machine's id. 5g
adds `qorpera_folder_view_open` and `qorpera_folder_view_close` to `CODING_HOST_RPCS`. The executor hands
`{environmentId, viewId, pass}` to the guest agent over exec stdin; the pass never goes into LXD config, `user.*` keys,
cloud-init or a file the host keeps.

- **A refused open** fails the attach, and the turn says why (the view's refusal: the session archived or expired, the
  repository withdrawn, the executor switched off).
- **An open with no answer** (the core unreachable) is retried until the attach's start deadline, then fails the
  attach as unreachable.
- **Renew and close** are the folder program's, as on every machine (C1b-3 §5): renew extends the lease by 120 s and
  closes the view with `ended` or `expired` once the session is no longer valid (the session row taken FOR SHARE, the
  token current, `qorpera_coding_attachment_refusal` null). The executor closes the view after the final boundary at
  detach, sleep or archive.

**Serving.** As step 4's 4a, the view's first renewal says its kind and machine, and the service checks the calling
VM's CID (`{project, name, physicalId}` from LXD):

- a `coding_session` view is served only to `qorpera-coding-machine-<machine_id hex>` in one of the node's
  `codingMachineProjects` (new, as step 4's `companyMachineProjects`; Q8), read-write, with a quiet publish about 2 s
  after its last change;
- a `code_host` view (new, 5a) is served only to its company's code host on the node, read-write within the code area
  rules (5b);
- no other machine gets either kind; a kind or machine that changes closes the view (as 4a).

**Access.** A coding worker's `workerAccess` is always `read`, and there it names the dispatch's sources, not folder
writes (the core's actor rule, `20260928259230_folder_core_views.sql:272`). A coding view reads and writes what both
the coding agent and the member may, with `agents/` and `rules/` read-only (the same rule), within the code area rules
(5b).

**The service that served a view** is named on it (`served_by`, new in 5a, set by the first renewal and cleared by a
clean stop). It is how a crash is noticed (rule 4 in "Reads").

## Mounts in the VM

The guest agent starts one folder program per session (P1 proposes it stays that way), as root, at
`/run/qorpera-folder/mounts/<worker32>`, with `--owner-uid` set to the session's uid and `allow_other`, so the session's
units, its Docker daemon and its root all see the same tree. Each session's program gets its own
`--local-dir /var/lib/qorpera-folder/local/<worker>` (5d's local layer), and all of them share the machine's one
`--cache-dir /var/lib/qorpera-folder/cache/machine`, with a lock per top cache folder (item 8's MC3,
RUNTIME-FOLDER-MACHINE-CACHES.md). Each unit of the session gets `/company` bound to that
path (`BindPaths`), as step 4's commands do. The program reaches the node's folder service on vsock, as on every
machine (step 1); the CID check is the boundary, so §6's "command units get RestrictAddressFamilies without AF_VSOCK"
no longer holds (root can open vsock anyway). A folder program that restarts (a crash, or root killing it) follows
step 4's 4d propagation proof: the new mount must reach every unit's `/company` or the unit is restarted (step 4's Q3
decides which).

The machine has no host filesystem: the NAS data and custody disks of today (`data-<worker32>`,
`custody-<worker32>`) are no longer plugged. §6's per-session NAS cache moves to the machine's disk (below), and
custody stays on the host (the executor writes it). The machine's disk keeps home, `/var/lib/docker`, caches and tmp
across sleep; it is recreated from the newest snapshot only while no session is attached (5h). Root can write anything
to it; it is the member's scratch, and "Machine disks" in §10 already allows coding cache folders there.

## Commands and sessions

**Each session has a uid** from 200000–524287, allocated by SQL per session as today, but no longer tied to a NAS volume
(5a moves the allocation out of `qorpera_coding_storage_volumes`). Its commands run as units
`qorpera-coding-<worker32>-<commandId>.service` in the slice `qorpera-coding-<worker32>.slice`, as that uid, with
`ProtectProc=invisible`, `PrivateIPC=yes` and the session's own network namespace, so two sessions can both listen on
port 3000 (NAT to the VM's NIC happens inside the guest). The uid has NOPASSWD sudo. These walls keep one member's
sessions out of each other's way; they are not security, and root removes them.

**The environment is the host's.** The executor builds each command's environment and hands it over exec stdin: the
git settings below as `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, the session's secrets (5j),
`DOCKER_HOST` for the session's rootless daemon, `HOME`, `TMPDIR` and the worktree as the working directory.

**Receipts and output are written host-side.** The guest agent streams a command's output over the host's exec
stream. The executor masks it (5j), writes `output.log` and the receipt into the worker's NAS custody folder on the
host and answers the model from what it wrote. The guest never sees custody, so root can't rewrite history; root can
only lie about what a command printed, which is its own session's affair.

**Re-attach.** A command keeps running in its unit when the executor restarts. The guest agent keeps an output ring per
command; the restarted executor re-attaches from the last byte it wrote and records any gap in the receipt (a gap is
output the ring had already dropped).

**The lease is the host's.** The executor keeps one lease per machine at `/run/qorpera-coding-host/<machine>.json` on
the node host. A host timer (`qorpera-coding-host-watchdog.timer`, 5g) force-stops any coding VM whose lease has lapsed.
The guest's `qorpera-coding-watchdog` timer stays in the image as a courtesy for an honest guest.

**When an attachment ends, the host stops its programs.** Root can confirm a stop and leave the programs running, so the
guest's answer is never the proof. Whether the session was archived, its renewal refused or its attachment lost (not
renewed in time), the executor closes the session's view, its sign-ins at the relay (5j) and its preview routes (5i)
host-side, asks the guest to stop the session's slice, and then, whatever the guest answered:

- **the last attachment on the machine** ended: it force-stops the VM. All the machine's sessions share a member, agent,
  repository and executor, so a refused renewal (the owner no longer a member, the repository grant withdrawn, the
  executor switched off) ends them all at once;
- **another session stays attached:** it restarts the VM within the minute (stop, then start on the same disk). The
  other sessions attach again, and their next turns are told what stopped, as after sleep. If the executor dies first,
  the machine's lease lapses and the watchdog stops the VM.

Contract compute item 3 keeps a session's programs until its own attachment ends or the machine sleeps; under a root
that can't be trusted, the contract's stop for the ended session is the stronger rule, so the others' programs stop with
the restart (Q1).

## Code areas and git

The layout is §6's: `code/<owner>/<name>/` holds `repo.git/` (bare), `main/` (the default branch, platform-only and
locked) and `worktrees/<workerId>/` on `qorpera/coding/<workerId>`. Every session of every member of the company that
the repository grant covers works in the same `repo.git`, through the folder; a session's commits are objects and refs
in the folder, credited to its view. The core's rules for code areas (§7 item 9, as amended below) are 5b's.
`qorpera_folder_path_reserved` already refuses `.git` and `node_modules` outside `code/`; nothing else of §7 item 9 is
built yet.

**Session-local git files.** `repo.git/config`, `repo.git/hooks/**`, `repo.git/info/**` and the session's
`repo.git/worktrees/<workerId>/config.worktree` are kept per session on the machine's disk and never published: the
folder program serves the session its own copy, seeded from the platform's published copy when the view opens, and
keeps its writes local. `objects/info/alternates` and
`objects/info/http-alternates` refuse every write with EPERM. This amends §6 "Who may write what" ("only coding
sessions may write a repository's config and hook scripts") and §7 item 9 ("`.git/config` and hooks writable only by
coding sessions"). Why: with root, a session can write any hook or `include.path`; published, that hook would run in
another member's VM, as that member's root, with that member's secrets. Code from another member's branch that a
session chooses to build or run is collaboration, as §6 already accepts; a hook that runs on `git commit` is not a
choice.

**Settings.** The host sets §6's table on every command through `GIT_CONFIG_*` (`filesRefLockTimeout` and
`packedRefsTimeout` 10000; `gc.auto` 0; `maintenance.auto` false; `gc.worktreePruneExpire` never; `core.symlinks`
true; `core.checkStat` minimal; `core.trustctime` false; `core.splitIndex` false; `index.sparse` false;
`core.fsmonitor` false and `core.sshCommand` pinned), plus `protocol.ext.allow=never` and a
`url.<relay>.insteadOf` for GitHub (5j). Under root these are defaults that keep honest tools working on the shared
directory, not walls; the walls are the folder's rules (5b) and the code host's own git (5e).

> **Scope reset, 2026-10-17.** The `insteadOf` for GitHub is deferred with the vault relay (the note at the top).

**The lock protocol, refusals, names and cleanup** are §6's ("Git on the mount"). The folder program serves them (5d):
an exclusive create of a shared `X.lock` takes the lease and refreshes `X` before `open()` returns (for `packed-refs` it
also reads the feed, and the machine forgets its listings of the loose refs, so git does not pack back a loose ref
another session deleted, even one the feed has not told the machine of yet), the rename over `X` is the publish point
inside the syscall (`git pack-refs`' rename of `packed-refs.new`, which the same lease guards, onto `packed-refs` too,
before it prunes a loose ref; the lock is then git's until git removes it, and another create of it is EEXIST), a lock's
removal publishes `X`'s pending change, `utime` under `repo.git/objects` returns EPERM, and a written file keeps its
time in the session's view. The code host's view (the platform's) writes the session-local files and every other file no
lease covers (`HEAD`, the probe files `git init` makes) as plain files its boundary publishes, so it can make a new
`repo.git`; a ref, `packed-refs`, `shallow` and a ref's log change under their lease for it too. A lease's change set
makes only the folders below `repo.git`, so the first publish under a lease in a `repo.git` new in the view runs a
boundary first, which saves the directory with `HEAD` and `config`. A view's machine is told its own new folder going
live, which still shows as the same folder, by a name below it that no folder holds (a control character): it lists the
folder again, as what the folder holds may change with it, and keeps the folder's entry. Told the folder's own path, the
kernel would drop that entry, and git working in that `repo.git` could no longer name its directory (`getcwd` fails).
The machine's listing of the folder above keeps the version the folder showed while pending, which the view reads as the
folder's live version, so an `rmdir` or a move that names it as its base does not conflict. After a publish under a
lease the view shows live again every new folder above what it published, up to a folder it shows live, even one that
still holds the view's own pending files (a new `repo.git`'s `refs`, beside its `refs/tags`): a new folder shows nothing
live in it, so git would not see the ref it just published.
The core enforces the rules (5b, §7 item 9 as amended here):

- `.git` and `repo.git` refused at any depth outside `code/<owner>/<name>/`, accepted inside;
- leases on the shared files in `repo.git` (`refs/`, `packed-refs`, `shallow`), with the version check at the rename
  as the correctness rule: `X` and its reflog `logs/X` land together or not at all. A lease lives as long as its view.
  Objects take no lease: a session writes them freely and never removes them;
- the per-worker rule: only a worker's session and the platform write under `worktrees/<workerId>/` and
  `repo.git/worktrees/<workerId>/`, and no session takes a lease on another worker's branch
  `refs/heads/qorpera/coding/<other>`;
- `refs/stash` refused (it is shared between all worktrees);
- no session deletes a published path under `repo.git/objects` (EPERM), and `objects/pack/*.keep` is never published;
- the session-local files above and the alternates files platform-only in the folder;
- §6's names under `code/` (`%`, `:` and device names allowed; NFC and no case-only siblings kept);
- old versions of `repo.git/objects/**` kept 7 days, not forever: a version goes 7 days after a write over it, a delete
  or a move ended it (pg_cron, each minute), and its bytes then wait for the folder's GC, which takes them only once
  nothing roots them. The current objects, the refs and the worktrees keep every version. The history view shows a
  change set's paths under `repo.git` (by key) as one line, the folder;
- the gc job blocking new leases in `repo.git` while it runs (5e).

**The cache list** (§6 "The per-session cache") moves from the session's NAS cache folder to the machine's disk: a
folder on the list lives on the disk, is never published, and other views and machines see nothing at its path. Since
the cache lives in the VM, the folder program keeps the list and reads the worktree's index (5d); a wrong list only
keeps the session's own files unpublished, which root could do anyway. The amendment's item 8 (dependencies and builds
in each machine's own cache) is a slice of its own for every machine; whichever of it and 5d lands first builds the
program's part, and the other reuses it. 5d builds it (the local layer, the worktree's list and the index reader), and
item 8's plan, [RUNTIME-FOLDER-MACHINE-CACHES.md](RUNTIME-FOLDER-MACHINE-CACHES.md), extends it: its rules hold in
every folder, not only in worktrees, from one table of names (MC1; the cache folders of every view live under
`caches/` in the local layer, at their folder's path); what git ignores in a worktree is a cache too, unless tracked
(MC2); and the cache moves to a folder the coding setup gives (`--cache-dir`), one per machine, so it outlives the
session (MC3).

**Links.** A checkout writes a mode-120000 entry as a symbolic link, and `git clone --local` hard-links objects. Links
in the folder are [RUNTIME-FOLDER-LINKS.md](RUNTIME-FOLDER-LINKS.md)'s (LK1–LK6), which leaves the per-session git
settings, `core.symlinks=true` among them, to step 5. 5d's tests with links need LK3 and LK4.

**Git's version.** §6 has the guest image, the seed and export helper and the gc host run the same pinned git. Root may
install any git in its VM, so the pin now holds only where the platform runs git (the code host, 5e) and as the base
image's default (5f).

**Packs over 256 MiB** stay §6's open question 4 (here Q13).

## Reads

Today a coding view's release during a leased turn writes the turn's run read set and takes the job's KEY SHARE, and
the read set carries to the session's later turns on the same machine (C1b-3 §6; the carry in
`qorpera_folder_view_open`). With root, one session can read through another session's mount on the same machine, so a
read can't be pinned to one session. Step 5 makes the machine the unit:

1. **Recording and release.** The folder service records each read it serves under a coding view, in memory, before
   the answer leaves the service; nothing the guest reports about reads counts. Each read reaches the machine's read
   set and every turn leased on the machine before any output of the machine reaches a model and before any save of
   the machine commits: the service releases the machine's recorded reads before each of its commits, quiet and
   synchronous publishes included. A turn leased later takes in the machine's read set when its lease starts. Not
   followed: a copy on the machine's disk of a read that never reached a model or a save (as step 4 and C1b-3 §6
   accept: "it does not trace every copy").
2. **The machine's read set lives with the disk.** A new machine id or a recreated disk starts clean; sleep keeps it.
3. **Boundaries come after reads.** A boundary (below) is answered only after every recorded read of the machine is
   released. A boundary with no answer holds the output back: the model gets nothing from the machine until it is
   answered.
4. **What can't be proven is refused.**
   - **A crashed service.** A view whose `served_by` is still set by a service that did not stop cleanly may have
     served reads that were never released. Every coding view that service served is refused, the VM is restarted and
     the sessions reopen their views. The machine's read set keeps what was released. Built (5g-5): the renewal that
     closes a coding view as `service_crashed` marks its machine (`folder_restart_at`) and closes the machine's other
     open coding views; `qorpera_folder_view_open` refuses a coding view on a marked machine ("Coding machine must
     restart first"). The executor restarts the machine for the folder when a view it holds was closed (`VIEW_CLOSED`),
     when the open is refused for the mark, when a view's final boundary answers `unproven` before another view opens
     on the machine, and when a publication answers `READS_UNPROVEN`: it marks the machine
     (`qorpera_mark_coding_machine_folder_restart`), ends its views, stops it (custody grants the stop of a marked
     machine under a leased turn), says `restarted`, and records the restart before the start
     (`qorpera_record_coding_machine_folder_restart`). The record detaches every session attached to the machine with
     a `FOLDER_RESTART` event, which is not an outside stop, and clears the mark. Each record is named by the start
     it comes before (the LXD operation of the effect that start follows) and kept with its answer, so a second record
     of the same start replays that answer and changes nothing. The session then attaches again,
     once; a second refusal fails its turn. A guest that rebooted itself costs one more restart.
   - **A new service run (5g-5).** A run of the service knows nothing of the reads a run before it served, so it counts
     every machine lost (its boundaries `unproven`, views or not) but those the last clean stop vouched for, in its
     note (RUNTIME-FOLDER-SERVICE.md, "The clean-stop note"); a machine is proven again once the executor says it
     restarted. `restarted` answers `dropped` when a read the machine was served may have gone unreleased. The guest
     agent keeps each command's record and output across boots, so before it says `restarted` the executor writes the
     boot before down as dropped (`dropped-start-<start operation id>.json` next to the machine's journal), and takes
     that back only when the service answers no. A command moved onto the new boot whose start is written down so ends
     `machine_stopped` (or `cancelled`) host-side, at the boundary's release, with what its boot printed past the last
     output the host kept counted lost: the guest is not asked for it. Each command starts, and is read, under
     the start the machine runs at that moment, read again after each start, whichever start its session or its
     transport was made under: none starts while the machine starts again, none runs once the machine started again
     before its run went out, and a turn that kept its transport across another session's restart reads its commands
     as moved. Every command's output is kept only if its start is still not written down right before it is kept,
     since a restart writes the mark before the boundary answers `released` again; so a call begun before that restart
     keeps nothing of the dropped boot either. A test machine says `restarted` at its first
     boot too, and at each boot after a stop, before SQL hears of the boot; it keeps nothing of a boot before.
   - **`unreadable`** (a released read the core can no longer place) moves the machine's sessions to a new machine id
     with a new disk, or archives them; the old disk is removed.
   - **The core's other refusals** hold the output back, as step 4's do: `QRC01` and `run_ended` are retried, `stopped`
     (the pause) is held, `denied` is held, and is final at the final boundary.

**SQL (5a).** The machine read set replaces the per-session carry:

- every coding view's release writes it and fans the read out to every turn leased on the machine, taking each turn's
  job KEY SHARE in id order;
- every coding commit rechecks it at rank 10, as a run's read set is rechecked today;
- a turn takes it in at its lease;
- the executor's disk-replacement call empties it, and that call is refused while a session is attached.

**Narrow marks (W6).** W6's machine rule assumed "if F3 shares mounts between sessions on one machine, the rule widens
to every mount on that machine". Step 5 is that case. 5a does `create or replace` on
`qorpera_memory_run_machine_narrow(p_environment_id, p_run_id)`: a turn is narrow when its flag is set or any open
coding view on the turn's machine holds a path outside the every-agent part (`qorpera_folder_path_every_agent`). Renew
(when the view holds such a path) and release (for a read outside the every-agent part) call
`qorpera_coding_turn_mark_narrow` for every turn leased on the machine. This needs W6a #986.

## Boundaries

A boundary on a coding machine covers the whole machine: the service flushes the machine's folder programs, releases
every recorded read of the machine, then publishes every view of the machine with pending changes. The executor asks
for it over a host-local Unix control socket of the folder service (5c), not through the guest.

| When | What happens |
| --- | --- |
| A command ends | a boundary, before its result is returned |
| Output is read while a command runs | a boundary first |
| A running program changes files | a quiet publish about 2 s after its last change, after the machine's recorded reads are released (rule 1) |
| git renames over or removes a shared lock | a synchronous publish (§6), after the machine's recorded reads are released (rule 1) |
| A browser screenshot reaches the model | a boundary first |
| A turn completes | a boundary, then the turn completes (the executor flushes releases and saves before completion, C1b-3 §6) |
| Detach, sleep or archive of a session | a final boundary for its view, then close and unmount |
| The machine sleeps | a final boundary for every view, then LXD stop |
| An attachment ends beside a live one, and the machine restarts ("When an attachment ends") | a final boundary for every view, then the restart; an unanswered boundary does not hold the restart past the minute, and its output stays held back |
| The service stops cleanly | it releases everything, publishes everything and clears `served_by` |
| The service crashed | rule 4 above |

A boundary's answer carries step 4's reasons per view (4c), so the turn's report says which view held what back.

## Setup file and snapshots

> **Scope reset, 2026-10-17.** This section is deferred with the rest of 5h, the Cursor and devcontainer
> mappings included (the note at the top). The merged setup parser and snapshot records (#1100 and #1131) stay,
> unused, with their tables and migrations. A coding machine with no setup is the accepted core baseline. The
> section stays as the record.

**Which file.** The first that exists at the root of the default branch: ours (`.qorpera/environment.json`, with
Cursor's keys), then `.cursor/environment.json`, then `.devcontainer/devcontainer.json`. The code host reads it with
`git show` (5e) and the executor parses it host-side under a strict schema; an unknown key is refused with a report, as
Cursor's own schema does ([environment.schema.json](https://www.cursor.com/schemas/environment.schema.json)).

**Cursor's keys** ([Cursor cloud agent setup](https://cursor.com/docs/cloud-agent/setup)): `build`
(`dockerfile` or `dockerfileContents`, `context`), `image`, `name`, `user`, `install` (idempotent, run again at every
attach), `start` (after boot), `terminals` (tmux), `ports` (`name`, `port`), `chromeExecutablePath`, `enable_testing`,
`disableAllMcpServers` and `mcpServerAllowlist` work as there. Three are ours to decide, and the plan decides them:

- `egressAllowlist` and `egressMode` are ignored with a report: the company's exit rules govern the network (item 11);
- `snapshot` and `agentCanUpdateSnapshot` are ignored: snapshots are the platform's (below);
- `repositoryDependencies` works for other repositories the grant covers (their worktrees are added beside), and is
  refused with a report for any other.

**devcontainer** ([the reference](https://containers.dev/implementors/json_reference/)) maps to the same:
`onCreateCommand`, `updateContentCommand` and `postCreateCommand` to install; `postStartCommand` to start;
`forwardPorts` to ports; `containerEnv` and `remoteEnv` to the environment; `remoteUser` to user; `image`, `build`
and `dockerFile` as Cursor's. Features run through the devcontainer CLI in the builder VM. `initializeCommand` runs in
the builder VM, never on a host. A compose-based devcontainer is settled in 5h: run in the VM's Docker if the proof
holds, else refused with a report.

**Snapshots.** One per member, repository and setup digest, keyed by the digest and the default branch's commit. A
refresh starts when either changes. It runs on a fresh builder VM: the agent plug, no `/company`, a `git archive` of the
default branch pushed in over exec stdin, `install` run with the member's secrets and the company secrets granted to the
repository (5j), then the checkout removed and the disk published as an LXD image. At most one build runs at a time per
repository and member. A failed build keeps the old snapshot; its masked log goes to the member, and the agent's next
turn is told. A snapshot is scratch: nothing in it is company data, and it can be rebuilt at any time.

**At attach** a new machine starts from the newest snapshot; an existing machine keeps its disk. The session's
`install` runs again in its worktree, then `start` and the terminals.

**An image or Dockerfile setup** builds with BuildKit in the builder VM, and the snapshot keeps the image and BuildKit's
cache. At attach the session's image is built again from its worktree (quick from the cache), and the session's commands
run in its container on the machine, with the worktree and `/company` bound in (proved in 5h, else Q12).

**Where snapshots are kept** is Q7 (recommended: per node, rebuilt where missing).

## Running apps

**Terminals.** Each session's terminals run in tmux in the VM. The web app streams them over a host-initiated exec,
read-only for the member (Q10 asks about typing). The executor masks the stream (5j).

**Previews.** A node proxy (5i) serves each preview on its own subdomain of a preview domain (Q6). Opening a port in
the web app gives a single-use capability, as the viewer gateway's ledger does for desktops
(`cloud-company-computer-viewer-gateway.ts`, `20260908000600_runtime_office_viewers.sql`), which the proxy trades for
a cookie scoped to that host. Only the session's member may open it. The proxy reaches the port through a stream the
host starts into the session's network namespace; the VM listens on nothing the host connects to.

**The browser.** A `coding_browser` tool drives headless Chromium in the session's network namespace (navigate, click,
type, screenshot). Its traffic is the session's, through the exit. A screenshot reaches the model only after a
boundary.

> **Scope reset, 2026-10-17.** Previews and the browser (5i), with Q6, are deferred (the note at the top). This
> note does not change the terminals.

## Secrets, MCP and the vault relay

> **Scope reset, 2026-10-17.** Core: environment secrets, injected host-side into each command and masked (5j-4),
> and the refusal of a save into the folder or a push that carries a value (5j-5). Deferred (the note at the top):
> the vault relay below, for MCP sign-ins and git fetch, and MCP servers inside coding sessions (5j-6c, 5j-6d,
> 5j-7). The broker half (5j-6b, #1266) stays, unused. A snapshot build's `install` waits with 5h.

**The kind.** A vault "environment secret": a name and a value, scoped to the member or to the company. A company
secret reaches a session only through a grant a current owner or administrator issued (contract 11.5); the grant's
unit is Q5 (recommended: per repository). Item 11's environment variables put a value inside the member's machine,
where root and every program can read it; contract 11.4 says secrets never enter model-visible paths, and 11.5 that an
agent gets a grant, not possession. The plan builds item 11 and asks Q4 about the conflict.

**Injection** is host-side: the executor reads the session's secrets from the vault and puts them into each command's
environment over exec stdin, and into a snapshot build's `install`. Nothing writes them to the VM's disk.

**Masking** is best effort (Q4):

- output, `output.log`, receipts and terminals: each value's exact, base64 and URL-encoded forms, across chunk
  boundaries, replaced before anything is written or reaches a model;
- saves: the folder service refuses a plain save or an inflated loose object that carries a value (a keyed rolling
  hash over values of at least a minimum length, so the service never holds the values in the clear);
- pushes: the broker's push check scans the diff and the commit messages and refuses a push that carries a value.

A program that encodes a value another way gets past the mask; that is why it is best effort.

Since 5j-4, the executor asks the company's secret broker for the session's environment once for each command it
starts, and masks that command's output, `output.log` and receipts with the values of every session on the machine.
The save and push checks are 5j-5.

**The vault relay** (5j) is host-side, on a second vsock port that checks the caller's CID, on the platform road
(agent exit §2: "the platform's own services keep the platform road, even when they act for an agent"). It does two
things:

- **MCP sign-ins.** A sign-in is added to the session at a local URL; the relay adds the credential and forwards only
  to that sign-in's own origin. The credential never enters the VM.
- **git fetch.** `url.<relay>.insteadOf` sends GitHub fetches to the relay, which serves upload-pack only, for
  repositories the grant covers; the broker fetches with its token, which never leaves the host. Pushes stay the
  broker's (5e).

The broker half is 5j-6b: the secret broker's `/v1/coding-mcp` and `/v1/coding-repository-fetch/{refs,upload-pack}`,
which only the coding executor's token opens (RUNTIME-STEP-7-CLOUD-CONNECTORS.md).

**MCP servers** run as programs in the VM, as item 11 says. A stdio server reaches the harness on the execution host
through a host-initiated stream; an HTTP server is reached the same way as a preview port.

## Docker

Each session has a rootless Docker daemon, started on first use, at `/run/user/<uid>/docker.sock` (`DOCKER_HOST`). Its
bind mounts see the session's `/company`. `sudo docker` reaches the system daemon, whose binds see the root mount
namespace: `/company` there is the session's only if the path is the full `/run/qorpera-folder/mounts/<worker32>`
(the caveat the report gives). Everything runs in the guest kernel; nothing reaches the host. 5f proves rootless
Docker and compose on a nested VM first; Q11 asks for the fallback if the proof fails.

## More machines

> **Scope reset, 2026-10-17.** 5k and Q9 are parked: capacity work, stopped in this rebuild. 5k's unmerged work
> is kept (the note at the top).

When a machine is full, a new attach opens the member's next machine for the same coding agent, repository and setup
digest (`number` + 1), from the same snapshot (5k). What "full" means is Q9 (recommended: counted by size, the sessions'
declared or measured memory and processor against the machine's, with a guest hint that can only open a new machine,
never keep a session on a full one). Sessions never move between machines while attached.

## The code host

A credential-free platform VM (5e), in its own LXD project (Q8), with no NIC: one per company on each node, started for
a job and stopped when idle (Q2 asks whether a VM is right, or the broker's sandbox on the host). It mounts `/company`
through a `code_host` view per job, which reaches only `code/` (5a), opened for the job and closed after it. A session
can write files the code host's git reads (its worktree, its own `repo.git/worktrees/<workerId>/`), so that git never
takes code or settings from the repository: `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`, the repository
config being the platform's own (sessions' copies are never published), `extensions.worktreeConfig` off,
`core.hooksPath=/dev/null`, no filters, no fsmonitor, no submodule recursion. One VM per company means a job that still
went wrong reaches only its own company. It does what no member's root may:

- **Seed.** The broker (`coding-git-seed.ts`, `coding-git-sandbox.ts`) bundles the repository with the token and
  streams the bundle over exec stdin; the code host fetches it into `repo.git` and checks NFC and case (§6 "Names").
- **Worktrees.** `git worktree add` and `git worktree lock` for each session; `main/` follows the default branch.
- **Export.** `git bundle create` of the session's branch, streamed to `coding-git.ts` (fsck, ancestry, push, draft
  PR). The token stays in the broker, on the host.
- **gc**, with the lease block (§6 "Cleanup"), and **reading the setup file** (`git show`).

It retires `cloud-coding-git-guest.ts`, `coding-git-transfer.ts`, the 64 MiB cap and git custody on the NAS.

A company's code hosts go with its deletion (coordinator decision D3; migration `20260930398000`). A code host is no
allocation and its code area is erased with the company folder, so the deletion does not wait for it. Each node's
coding executor asks at its start and every minute after, beside its housekeeping, which of the companies with a code
host project on the node are being deleted (`qorpera_code_hosts_deleting`, read-only, under its custody check), and
removes each of their code hosts with its project. The listing of the node's projects and each removal, its wait for the
host's other steps among it, have the agent wait; a removal out of time never runs later. One in a job or with a job
waiting for its start (`CODE_HOST_BUSY` at once), refused, failed or out of time is logged and goes on a later pass, as
does one a job made again after its removal.

## The report

A turn's report gives what step 4's gives (the views' reasons, what was held back and why), plus: the setup file used
and anything in it ignored or refused, the snapshot's commit and age (and a failed refresh with its log), secrets
masked in the turn's output, the Docker path caveat when the session used `sudo docker` with a `/company` bind, and a
machine moved or restarted by rule 4 or by another session's attachment ending.

## Slices

Migration slots and SQL test numbers are reserved in the registry when a slice is built.

| Slice | What | Tests |
| --- | --- | --- |
| 5a | SQL: coding views on member machines. The machine read set (written and fanned out by every coding release, rechecked at rank 10 by every coding commit, taken in at a turn's lease, emptied by the disk-replacement call, which is refused while a session is attached), replacing the per-session carry. `create or replace qorpera_memory_run_machine_narrow` and `qorpera_coding_turn_mark_narrow` from renew and release (after #986). `served_by` on views and the crashed-service refusal. The `code_host` view kind (platform-only, `code/` only). The machine row's `staff_agent_id`, `repository`, `setup_digest` and `number`, and the widened `qorpera_coding_machines_current`. Session uids allocated apart from `qorpera_coding_storage_volumes` | A read released by one session's view reaches every turn leased on the machine, and a turn leased later takes it in; a commit after a narrowing of a read path refuses for every session on the machine; the disk-replacement call empties the set and is refused while a session is attached; a turn on a machine with a view holding a non-every-agent path is narrow, and one with only every-agent paths is not; a view served by a crashed service is refused, a cleanly stopped one is not; `code_host` views open only for the platform and refuse a path outside `code/`; two sessions of one member with different agents, repositories or setup digests get different machines (two repositories with the same setup file too), with the same ones the same machine |
| 5b | SQL: code areas (§7 item 9 as amended). `.git` and `repo.git` only inside `code/<owner>/<name>/`; leases and synchronous publish units; the per-worker rule; `refs/stash` refused; no object deletes, `.keep` never published; session-local files and alternates platform-only; §6's names; 7-day object versions and the history fold; the gc lease block | One test per rule, each refused for a session and allowed for the platform where §6 says so; a lease held by one session makes another's lock fail; the version check refuses a second writer after an expired lease; a session's config or hook write refused in the folder |
| 5c | Folder service: coding views. Serving only to the view's own coding machine in `codingMachineProjects`, or to its company's code host for `code_host`; the in-memory read record before an answer leaves; release fan-out; the host-local control socket and machine-wide boundaries; `served_by` set and cleared; reasons as 4c | The service's tests with a stand-in core: a coding view refused from another coding machine, an office, the execution host or an unlisted project; a read is recorded before its answer; a boundary is answered only after every read of the machine is released; a boundary with a refused release holds; a clean stop clears `served_by`; the control socket refuses a peer that is not the executor's uid |
| 5d | Folder service and program: git on the mount. §6's lock protocol (lease on exclusive create, refresh before `open()` returns, publish on rename, publish on lock removal, rename onto a held lock), session-local `config`, `hooks/**`, `info/**` and `config.worktree`, EPERM for alternates and `utime` on objects, file times, the index reader and the cache list on the machine's disk | FUSE tests with real git (the pinned version) against a stand-in core: commit, rebase, fetch with N refs, `branch -D`, a killed git leaving a lock, two sessions racing one ref, a hook written in one session not seen in another, a cache folder never published and dropped from the list once tracked; merges after 5b |
| 5e | The code host: one VM per company on each node, its project, no NIC, started for a job and stopped when idle, a `code_host` view per job; seed from the broker's bundle; worktree add and lock; `main/` following the default branch; export bundle to `coding-git.ts`; gc with the lease block; reading the setup file | Runtime tests for each job with a stand-in exec; a seed refused for an NFC or case problem, naming the paths; an export of a branch that is not the session's refused; gc holds new leases in `repo.git` and releases them; the code host's git ignores a hook, a filter, `include.path` and `extensions.worktreeConfig` set in the repository or a session's `config.worktree`; one company's job never sees another company's code area |
| 5f | Base image: toolchains, tmux, Chromium, rootless Docker and compose, NOPASSWD sudo per session uid, the guest agent, the apt timers masked, `security.devlxd=false` | Image build test on the test machine; in a throwaway nested VM: rootless Docker and compose run a two-service app, `sudo` works, `/dev/lxd` absent, nothing on the host changes (modules, sysctls, nft listed before and after) |
| 5g | Executor and guest agent: the cutover. Views opened after attach and closed after the final boundary; mounts and binds; command units, network namespaces and the host-built environment; receipts and output host-side; re-attach from the output ring; boundaries through the control socket; rule 4's restart and the `unreadable` move; the host lease and watchdog; the host's stop when an attachment ends; terminals; the vsock listener list | Runtime tests: a refused open fails the attach with its reason, an unanswered one retries until the deadline; output reaches the model only after a boundary; a restarted executor re-attaches and records a gap; a lapsed lease force-stops the VM; with a guest that confirms a stop and leaves the programs running, the ended session's programs are gone within the minute after an archive, a refused renewal and a lost attachment, each with and without another session attached (the VM restarted or stopped), and the other sessions are told what stopped; a crashed service restarts the VM and reopens the views; the host listens to coding VMs only on the two CID-checked ports |
| 5h | Setup file and snapshots: the three formats and their mapping, the strict schema, builder VMs, the digest with each named Dockerfile's bytes, snapshot keys and refresh, one build at a time, a failed build keeps the old snapshot, `install` at attach, image and Dockerfile setups (BuildKit, the image built again from the worktree at attach), compose devcontainers settled | Parser tests for each format and each ignored or refused key; a refresh on a setup change and on a default-branch change; a failed build keeps the old snapshot and reports its log; a second build for the same repository and member waits; a change to a named Dockerfile alone gives a new digest, so the next new session gets a new machine; a context file changed on a session's branch is in the image built at attach |
| 5i | Previews and the browser: the preview proxy, single-use capabilities and host cookies, member-only access, host-initiated streams; the `coding_browser` tool with a boundary before each screenshot | Proxy tests: a capability works once, a cookie works only on its host, another member is refused; a screenshot waits for a boundary |
| 5j | Secrets and the vault relay: environment secrets (member and company, with grants), host-side injection, masking in output, logs, receipts, terminals, saves and pushes, the relay for MCP sign-ins and git fetch | Masking across chunk boundaries and in base64 and URL forms; a save carrying a value refused; a push carrying a value refused; a company secret without a grant not injected; the relay forwards a sign-in only to its own origin and refuses a push; the SQL part may land before 5g |
| 5k | A second machine: `number`, the full rule, opening the next machine from the same snapshot | A full machine opens the next one for the same agent, repository and digest; a session never moves while attached |
| 5l | Retirements after step 6: the private repository folder, `cloud-coding-git-guest.ts`, `coding-git-transfer.ts`, the 64 MiB cap, the storage and command helpers, the NAS data and custody plugs, COMMAND-GUEST.md | The changed tests pass with the old paths gone; `git grep` finds no caller |
| 5m | Live proof (below) | — |

**Order.** 5a, 5b, 5c, 5d and 5f can be built side by side (5c and 5d against a stand-in core; 5d merges after 5b).
5d's tests with links need LK3 and LK4. 5e needs 5a–5d. 5g needs 5a, 5c, 5e and 5f; no coding machine mounts the
folder before 5g. 5h, 5i, 5j and 5k each need 5g and can run side by side (5j's SQL can land earlier). 5l needs 5g and
step 6. 5m comes last.

> **Scope reset, 2026-10-17.** The rest of 5h (after the merged setup parser and snapshot records), 5i, 5j's relay
> and MCP part (5j-6c, 5j-6d, 5j-7) and the 5m run are deferred, and 5k and 5l are parked (the note at the top).
> 5j's secrets, masking and refusals (5j-4, 5j-5) stay core. The note under the proofs below says which proofs
> core acceptance still needs.

**Live proof (5m)**, on a test company, without Codex:
- a snapshot builds for each setup format (ours, Cursor's, a devcontainer with a feature); a broken `install` keeps the
  old snapshot and the member sees the log;
- a secret used by `install` is masked in the build log;
- the code host seeds a repository, and its `main/` shows in the web app's folder; gc runs and holds leases meanwhile;
- the host watchdog force-stops a VM whose lease was left to lapse;
- from a coding VM, a vsock probe to the folder service under another machine's view is refused (the CID check), and
  nothing on the host answers on any other port;
- the node host is unchanged: modules, sysctls and nft rules listed before and after are the same.

**Deferred (needs Codex):** everything a coding turn drives. `sudo apt install` and a language the image lacks; `docker
compose up` with a bind of `/company`; commits on the shared `repo.git` from two sessions of one member, and from two
members, with a race on one ref; a pull request from a session's branch; a preview opened by the member; a browser
screenshot reaching the model; a secret masked in a tool result and refused in a save; an MCP server with a sign-in; a
second machine when the first is full; a narrowing during a turn on a shared machine stopping every turn on it; the
numbers (attach time with and without a snapshot, the folder program's memory per session).

> **Scope reset, 2026-10-17.** The 5m run is deferred as a whole (the note at the top), and its proofs split so:
> - **core**, proved by the coordinator's core list of 17 October rather than by 5m: a coding session end to end,
>   with idle sleep and quiet-day archival; a clean restart after a folder service crash or an unreadable read; a
>   vault secret masked in output and refused in a save or a push; then the same live after the rollout. The rules
>   behind 5m's other checks (the code host's seed and gc, the watchdog, the vsock probe, the unchanged host) stay
>   pinned by the tests in the rows of 5c, 5e, 5f and 5g;
> - **later features**, waiting with their slices: a snapshot for each setup format, a broken `install` keeping the
>   old one, a secret masked in the build log and the attach time with a snapshot (5h); the preview and the browser
>   screenshot (5i); an MCP server with a sign-in (5j-6c to 5j-7); the second machine (5k).
>
> This note records scope; it says nothing about which proofs have run.

**Settled in step 5's implementation.** This plan fixes the rules and the tests above. The mechanics behind them are
designed in their slice's PR and reviewed there against those rules, each pinned by the tests named in its row:
- the read record's shape in the service and the control socket's protocol: 5c;
- how the program keeps session-local git files and reads the index: 5d;
- the guest agent's protocol and its output ring: 5g;
- the strict schema and the setup digest's normal form: 5h;
- the masking hash and its minimum length: 5j.

A case a slice's review finds that these rules already decide is fixed in that slice, with a test; this plan changes
only if a rule is wrong.

## What this plan amends

- [RUNTIME-COMPANY-FOLDER.md](RUNTIME-COMPANY-FOLDER.md) §6 "The mount": the line "command units get
  RestrictAddressFamilies without AF_VSOCK" no longer holds on coding machines; the CID check is the boundary.
- §6's per-session NAS cache and custody folders: the cache moves to the machine's disk; custody is written host-side
  only.
- §6 "Who may write what" and §7 item 9: `repo.git/config`, `hooks/**`, `info/**` and a worktree's `config.worktree`
  are session-local and never published; alternates are platform-only.
- §6's seed and export line ("change to work through the shared git directory"): they run on the code host. §6's git
  version line: the pin holds where the platform runs git.
- C1b-3 §5's per-session carry and §6's release: the machine read set and its fan-out replace them.
- [COMMAND-GUEST.md](../coding-worker/COMMAND-GUEST.md): replaced by the guest agent; its no-root amendment ends when 5g
  lands.
- W6's assumption about shared mounts: the rule widens to every view on the machine (Reads).

## Proposals and questions

- **P1 (after 5m).** One folder program per session. If 5m's numbers show too much memory, one program could serve all
  views of a machine (they share one authority).
- **P2 (after 5m).** One listed tree per machine, since all its views share one authority, with receipts still per
  view.
- **P3 (only if the coordinator asks).** A durable read ledger, so a crashed service needs no VM restart. It conflicts
  with founder decision 1 (the folder service keeps no state beyond memory), so the plan does not build it.
- **Q1 (coordinator).** Grouping: one machine per member, coding agent, repository and setup digest. Jonas said one per
  member (24 September 2026); the plan splits by agent because root reads every view on a machine, and by repository and
  setup digest because item 11 sets "the repository's machine" up from its setup file and a snapshot is the machine's
  disk. The cost of sharing: when one session's attachment ends, the machine restarts and the other sessions' programs
  stop ("When an attachment ends"). One machine per session would avoid that, with more VMs and no shared disk.
- **Q2 (coordinator).** Where the code host runs: a platform VM with no NIC, one per company on each node, started for
  a job (recommended); one VM per node for every company (fewer boots, but one VM then holds every company's code
  areas); or the broker's sandbox on the host.
- **Q3 (coordinator).** Step 5 and step 6 meet at `/mnt/repository`: a test machine started with `repositoryWorker`
  attaches the session's private repository folder there, read-only (`deploy/machine/README.md`), and step 6 replaces
  it with `/company`. From 5g, sessions work in the shared `repo.git`, so that folder is no longer updated until step 6
  lands. Recommended: accept the gap (there are no users); 5l retires the folder after step 6. Step 6's 6e-1
  (migration `20260930506000`) retired `/mnt/repository` and `repositoryWorker`.
- **Q4 (coordinator, Jonas).** Item 11's environment variables against contract 11.4 and 11.5, and how strong masking
  must be. The plan builds item 11 with best-effort masking.
- **Q5 (coordinator).** The grant unit for company secrets: per repository (recommended), per agent or per session.
- **Q6 (coordinator, Jonas).** The preview domain, its TLS and who may open a preview (the plan: the session's member
  only).
- **Q7 (coordinator).** Where snapshots are kept: per node, rebuilt where missing (recommended), or on the NAS.
- **Q8 (coordinator).** The LXD projects for `codingMachineProjects`, and the code host's project.
- **Q9 (coordinator).** When a machine is full: counted by size (recommended), with a guest hint that can only open a
  new machine.
- **Q10 (Jonas).** May the member type into a session's terminal, or only watch?
- **Q11 (coordinator, only if 5f's proof fails).** The fallback if rootless Docker does not work in the VM.
- **Q12 (coordinator, only if 5h's proof fails).** Image and Dockerfile setups if commands can't run in the built
  container.
- **Q13 (coordinator).** Packs over 256 MiB (§6's open question 4).

> **Scope reset, 2026-10-17.** Q6 (5i), Q7 and Q12 (5h) and Q9 (5k) wait with their deferred or parked slices, and
> P1 and P2 with the 5m run. In Q3, retiring the private repository folder waits with 5l.
