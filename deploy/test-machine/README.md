# Operator test machines

One virtual machine per node runs Qorpera's own SQL and Linux test suites, instead of Docker on a
developer Mac (contract 24.1: runtime verification uses the Linux runtime-hosting machines). They are
operator infrastructure. They hold no company data, no credentials and no product role. Agents' test
machines (#419) are a separate product feature.

| Machine | Node | Address | State |
| --- | --- | --- | --- |
| `node02`: `qorpera-testvm-node02` | `company41-node-02` | `tester@10.201.0.2` | since 2026-09-28; 10 vCPU since 2026-09-29 |
| `node01`: `qorpera-testvm-node01` | `company41-node-01` | `tester@10.201.0.3` | planned: [NODE-01.md](NODE-01.md) (design and runbook) |

`scripts/run-on-node.mjs` lists both and sends each run to the one with the most free slots (below). A
machine that does not answer is skipped, so the list may name a machine before it exists.

## What it is

| Item | Value |
| --- | --- |
| VM | `qorpera-testvm-<node>` in LXD project `testmachines` (restricted: managed disks and NICs on `testmach0` only, no containers, no low-level VM options; project limits 10 vCPU, 16 GiB, 160 GiB) |
| Size | 10 vCPU, 16 GiB RAM, 150 GiB root disk on pool `qorpera-vm`, `boot.autostart=false`, marker `user.test-machine-purpose`. Node 2's was made at 6 vCPU for PR #326's physical acceptance (6+ CPUs, 16 GiB, KVM) and resized to 10 on 2026-09-29 (12 does not fit node 2: below). Setup records whether `/dev/kvm` is present |
| Image | Ubuntu 26.04 server, then [`guest-setup.sh`](guest-setup.sh): Docker Engine (rootful), Node 24.21.0 (pinned checksum), Git, build tools, Python, bubblewrap, LXD 6.9 rev 40424 for nested tests. The pinned PostgreSQL image of `scripts/test-hosted-db.mjs`, `node:24-bookworm-slim` and `node:22-bookworm-slim` (the runtime office probes, as in CI) and api-front's pinned `envoyproxy/envoy:v1.39.1` (`deploy/sites/envoy-front-sites.test.mjs`) are pre-pulled. Stopped containers, dangling images and build cache older than a week are pruned weekly |
| Self-update | `apt-daily*` and `unattended-upgrades` are masked, as for coding images (`deploy/coding-worker/COMMAND-GUEST.md`), and every snap is held |
| Network | Bridge `testmach0` on each node (10.201.0.1/24, NAT, no IPv6; the guest guard's `testmach0` subnet), VM at 10.201.0.2 (node 2) or 10.201.0.3 (node 1) with MAC/IP filtering and port isolation. The addresses differ so that each machine's host key has its own line in `~/.ssh/known_hosts_qorpera_test_machines` |
| Egress | ACL `testmach-egress`: the internet only. Rejected: 10/8 except the bridge's own /24, 172.16/12, 192.168/16 (LAN and NAS), 100.64/10 (Tailscale), 169.254/16, 127/8, 0/8, 192.0.0/24, 198.18/15, 224/4 and all IPv6. The node itself (the gateway) is rejected on every TCP and UDP port except DNS and DHCP; ICMP to it is not blocked. LXD applies reject rules before allow rules, so the rejects are written to leave the needed holes rather than relying on allow rules |
| Ingress | Only SSH from the node (10.201.0.1). Developer sessions jump through the node's normal SSH login |
| Login | User `tester` (docker and passwordless sudo inside the VM), key only. Root login and passwords are off |
| Runner users | `ci01` to `ci16`, same rights as `tester`. Each run takes a free one for its whole duration (below) |

## Node accounting

Every LXD instance on a node must be a registered allocation or enrolled infrastructure,
otherwise the node reports `unavailable` (`deploy/first-node/RUNTIME-HOST-INVENTORY.md`). Each
VM is enrolled exactly as infrastructure (`NODE-BUILDER-COEXISTENCE.md`, "Exact builder
enrollment"). Node 2's headroom covers operating + execution host + build space + its VM:
4000 + 4000 + 6000 + 10000 = 24000 mCPU (the most node 2 allows: a standard 8000 mCPU slot must
stay) and 24 + 8 + 16 + 16 = 64 GiB. Node 1's numbers are in [NODE-01.md](NODE-01.md). A VM's
10000 mCPU / 16 GiB is charged whether it runs or not, so its node's placement budget is
permanently that much smaller. `boot.autostart` is `false`: after a node reboot the VM stays
stopped until an operator starts it, and runs go to the other machine meanwhile.

The enrollment pins the VM's physical UUID and configuration digest. Changing its LXD
configuration, devices or limits, or rebuilding it, needs a new enrollment under an admission
hold, run or reviewed by the coordinator. Work inside the guest (packages, Docker images, files)
does not change the digest.

## Running a suite

```sh
node scripts/run-on-node.mjs changed
node scripts/run-on-node.mjs test
node scripts/run-on-node.mjs hosted-db
node scripts/run-on-node.mjs hosted-db -- --only 810,811
node scripts/run-on-node.mjs --env QORPERA_OFFICE_TEST_IMAGE=node:24-bookworm-slim scripts/test-office-storage-inventory-linux.mjs
node scripts/run-on-node.mjs --no-install -- docker run --rm hello-world
node scripts/run-on-node.mjs --dry-run npm:test:scripts
node scripts/run-on-node.mjs --machine node01 hosted-db
```

Start runs with `</dev/null` from a background shell: `lxc … create` and `lxc init` read YAML from a stdin
that is not a terminal, and ssh passes an open one through.

`changed` is the everyday check: it runs what the files changed against `origin/master` (or `--base REF`)
need, and prints what it chose and why. The steps and the paths that start them are in
[`scripts/run-on-node-plan.mjs`](../../scripts/run-on-node-plan.mjs). They replace the switched-off GitHub
workflows and run at least what those ran for the same change:

- documentation alone: nothing;
- any other change: lint, the root and member-web typechecks, and the repository checks (pinned dependencies,
  imports, cloud boundaries, connector catalog, runtime bundle);
- any change that is not web-only: also all runtime and cloud-client tests and all script tests (packaging and
  installer pins included), as the old release train did;
- on top, by path: the web client (with its release build), member-web, object-gateway, runner-orchestrator,
  Supabase functions, node deploy tests, deploy shell syntax, hosted-db with its PostgreSQL scripts;
- shared configuration (`package.json`, the lockfile, `tsconfig`, `vitest.base.ts`, `biome.json`,
  `packages/contracts`, `packages/company`) and any path no rule knows: every step.

A moved file counts at both paths. Every step runs even when an earlier one fails. The full `test` suite is
for release candidates.

The wrapper copies the working tree git sees: tracked and untracked files that are not ignored,
uncommitted changes included, `node_modules` and `.git` left out. It copies them to a fresh
directory on the VM, and only changed files cross the network (rsync `--copy-dest` against a
per-worktree copy). It runs `npm ci --ignore-scripts` there (skipped for `hosted-db`, which needs
no packages), streams the output, and exits with the suite's exit code. The `test` suite is the whole
repository's `npm test`; it first runs `npm run build:web-sdk`, because the script tests import the built
`@qorpera/contracts` (`--build` does the same for any suite).

Each run takes one of the runner users `ci01` to `ci16`, under a lock held until the run ends, and hands
it the run directory; install and suite run as that user. Kernel limits per user then count one run
only. This matters: the coding Git sandbox runs under `prlimit --nproc=512`, and RLIMIT_NPROC counts
every task of the user on the machine. When all runs shared `tester`, a few parallel sessions pushed it
past 512 and bubblewrap failed with "Creating new namespace failed: Resource temporarily unavailable".
When all 16 are busy, a run waits (up to an hour).

At most five runs execute at once, and each runs vitest with `VITEST_MAX_WORKERS` = vCPUs / 5 (2 on
10 or 12 vCPUs; a `--env VITEST_MAX_WORKERS=n` on the command wins), so the five slots together use the
machine's vCPUs. The record notes the load and the uncapped test processes (older clients) at start. A full
`npm test` is about 881 CPU-seconds; on 2026-09-29 two full runs plus other sessions drove the load to 22
and timing-bound tests failed that pass on a quiet machine. On 2026-10-14, with three slots, both machines
had all three busy and 3-4 runs waiting at load 4-6 on 10 vCPUs, with ~12 GiB of 15.5 available and no memory
pressure, so a fourth slot was added. On 2026-10-15, with four slots, both machines had all four busy and 11-15
runs waiting, at load 6-8 with the vCPUs 26-34% busy on node02 and about 55% on node01 (36-83% over a minute),
iowait at most 4% and ~11.5 GiB available, so a fifth slot was added; each run keeps 2 workers on 10 vCPUs. A client
from before a change still takes only its own number of slots, so while it is first in the queue it waits for one of
those even when a higher slot is free.

A run without `--front` takes only slots 1-4: slot 5 is kept for `--front` runs (pr-loop's batch), which try it
first, so a batch starts at once even on a full machine (in proof run 20261016T144011 one of its parts waited 587 s
for a slot). `guest-setup.sh` makes slot 5's lock file root's and read-only (`/etc/tmpfiles.d/qorpera-test-machine.conf`
makes it again at boot): current clients open a slot's file for reading, while clients from before the change open it
for writing and so skip it. A `--front --cores` run takes more slots as they free, up to three, but only while the
machine has at least 2 GiB available (`MemAvailable`); below that it leaves the queue until there is more. With five
busy runs node01 had dropped to 1264 MiB.

Later runs wait in arrival order and print
their queue position; the record notes the slot and the time spent queued. Each runner user keeps its own npm cache, so
`npm ci` takes about 30 s the first time and 5-6 s after that. The run directory is
deleted afterwards (`--keep` keeps it; it then belongs to the runner user, so use sudo inside it). At the start of every run, runs older than a day (by the UTC time
in their name), worktree copies unused for 3 days and hosted-db containers older than 6 hours are removed.
Untracked files that look like credentials (`.env`, `.env.*`, `*.env`, `.envrc`, `.npmrc`, `.netrc`, `.pgpass`,
`.git-credentials`, `.aws/credentials`, `*.pem`, `*.key`, `*.p12`, `*.tfvars`, `id_*` without an extension,
`credentials*.json`, `service-account*.json`, `*.private.json`) stop the run unless `--allow-secrets` is given.

The last line is a JSON record: host, OS, kernel, Node, npm, Docker and Git versions, KVM, source
commit and a digest of exactly the files copied, command, copy, preparation and elapsed time, and the
result (`passed`, `failed`, `setup-failed` when `npm ci`, the build or the harness failed, or `unknown`
when the status could not be read back), the runner user, the slot and time queued, and for `changed` the
plan and its base. This
is the record contract 24.4 asks for. It names the `machine` the run used, what every machine answered
(`machines`), how long asking took (`probeSeconds`) and, when the first choice failed before the suite started,
the machines `passedOver`.
`--record FILE` also writes it to a file.

The hosted-db suite and the other PostgreSQL scripts run `POSTGRES_IMAGE` (`scripts/test-hosted-db.mjs`), which
`guest-setup.sh` pulls too: PostgreSQL 17.6 on Debian's glibc, started on production's locale (ICU en-US, `POSTGRES_LOCALE`).
A cluster on another locale stops the run.

Several sessions can use a machine at once. Each run has its own directory and runner user, and the
hosted-db harness names its containers per process. Slots, queue, runner users, npm caches and worktree copies
are per machine: two machines run ten suites at once.

### Which machine

One run, one machine. At the start the wrapper asks every listed machine at once, over SSH and read-only, how
many of its five slots runs hold, how many runs wait in its queue and how many are still being copied there
(a marker per run, from its first SSH call until it takes a queue ticket). A probe answers in about a second;
its connection must reach the machine within 6 s. Once one machine has answered with a free slot, the others
get 2 s more; otherwise every probe gets up to 12 s. The wrapper takes the machine with the most free slots,
counting waiting and arriving runs against them; on a tie, the list order (`node02`, then `node01`). The
answers are printed before the run starts. A machine that did not answer (its VM stopped after a node reboot,
its node being updated, a machine not built yet, a slow moment) is tried only when no machine that answered is
open. If a machine fails before the suite starts (the first SSH call or the copy), the run moves to the next
one, and the final error names each machine's failure; a copy that an interrupt ended, or that failed on files
of this tree (rsync 23, 24), stops the run instead. A suite that has started is never repeated elsewhere: its failure is the result.

Each machine keeps its own queue, so a run that had to queue stays in that machine's queue even if the other
frees up first. The choice makes that rare: a run joins the shorter queue. Two runs that ask within a moment of
each other, before either has made its marker, can still choose the same machine.

`--machine node01` (or `node02`) skips the choice. Use it to work with one machine's state: a Docker image ID
(the systemd suites below), a `--keep` run directory, or a check of a machine that is closed.

To take a machine out of the choice (maintenance, removal), close it from inside: as root, write a reason to
`/etc/qorpera-test-machine-closed`. New runs go to the other machine; runs already running or queued there
finish; `--machine` and a `QORPERA_TEST_MACHINE*` target still reach it. A machine without
`/etc/qorpera-test-machine-versions`, which `guest-setup.sh` writes last, is left out too (`setUp` false, "not
set up" in the output). `--dry-run` shows `closed`, `setUp`, `busy`, `waiting` and `arriving` per machine. Delete the file to open it again.
Clients older than this list (sessions that have not merged master) send every run to node 2 and do not read
the file.

### Results on the PR

A plain run of a named suite (`changed`, `test`, `hosted-db`, `npm:…`, `scripts/….mjs`) on a clean commit that a
pushed branch contains posts its result as the GitHub commit status `qorpera-ci/<suite>` on that commit:
`pending` while it runs, then `success`, `failure` (the suite, or its `npm ci` or build; a `changed` run names
its failed steps) or `error` (the harness never reached a result, or the run was interrupted). The PR shows it
as a check. The context is the same whichever machine ran it (both are built from the same recipe and run
the same suites); the description names the machine: `passed on node 1 in 6m12s: 9 steps (ci03)`. The
pending status names the machine the run waits on. The statuses API uses no Actions minutes.

Nothing is posted, and the run says why, for: uncommitted or untracked changes; a commit on no pushed branch;
ad-hoc `-- command` runs; suite arguments, `--env`, `--sudo` or an install/build override (a narrowed run cannot
speak for the suite); `changed` with a `--base` other than `origin/master` (a later base can make its plan
empty), or on a commit master already contains (nothing changed: run `test` instead); a target set through
`QORPERA_TEST_MACHINE*`; `--no-status`. If the working tree changes while it is copied, the run posts `error` instead of a
result. A failed post never changes the run's exit code.

The statuses are advisory: the repository's plan has no branch protection, so merging cannot require them,
and anyone with write access can post a `qorpera-ci/…` state.

Access needs the key `~/.ssh/id_ed25519_qorpera_testvm` (one key for both machines) and SSH to
`company41-node-02` and `company41-node-01`. The first connection to a machine records its host key
(`StrictHostKeyChecking=accept-new`). `QORPERA_TEST_MACHINE` and `QORPERA_TEST_MACHINE_JUMP` point a run at one
other machine instead of the list (no status is posted then); `QORPERA_TEST_MACHINE_KEY` replaces the key.

## The systemd suites

The `scripts/*-systemd.mjs` suites boot systemd as PID 1 in a disposable container and take a
digest-pinned local image in `QORPERA_OFFICE_SYSTEMD_TEST_IMAGE`: Ubuntu 26.04 with systemd, its Node 22
package and the executables the office image installer measures. Each test machine keeps one as
`qorpera-systemd-test:local`, with its own ID; look up the ID on the machine that will run the suite and pass
`--machine` to both commands. Build it only when the tag is missing
(about 90 s cold). Every build gets a new ID, even fully cached, and Docker's containerd image store
here deletes the image a moved tag pointed to, so another session's run that still uses the old ID
fails with "No such image" (happened 2026-09-28). After a Dockerfile change, build under a new tag
such as `qorpera-systemd-test:<commit>` and pass that ID.

```sh
node scripts/run-on-node.mjs --machine node02 --no-install -- docker image inspect --format '{{.Id}}' qorpera-systemd-test:local
node scripts/run-on-node.mjs --machine node02 --no-install -- sh -c 'docker build -q -t qorpera-systemd-test:local - < scripts/fixtures/systemd-test-image.Dockerfile'
node scripts/run-on-node.mjs --machine node02 --env QORPERA_OFFICE_SYSTEMD_TEST_IMAGE=sha256:<id> scripts/test-office-image-installation-systemd.mjs
node scripts/run-on-node.mjs --machine node02 --env QORPERA_OFFICE_SYSTEMD_TEST_IMAGE=sha256:<id> scripts/test-office-service-stop-systemd.mjs -- --restart
```

The same Dockerfile builds on Docker Desktop. On a Linux Docker host the suites differ from Docker
Desktop in four ways, all handled in the scripts: the containers run without AppArmor (the trade-off
is in `scripts/fixtures/systemd-container.mjs`), the fixture sees the host's AppArmor as disabled because
the container cannot load profiles, staged packages are chowned to root because a copy keeps the
invoking user's owner, and the observer and office provider fixtures reset their package folder's mode,
which follows the host umask (Ubuntu's user default is 0002). Without AppArmor, root in these
containers can change the host kernel's settings: run them here or on a developer's Docker, never on
a node that hosts companies.

## Proof (2026-09-28, VM enrolled at node 2 version 23)

| Check | Result |
| --- | --- |
| Network | Lease, DNS and HTTPS work. The NAS (192.168.1.40:22, :2049), a Tailscale peer, node 2's LAN and Tailscale addresses, the router, and the gateways of this and two other bridges are refused from the VM while node 2 itself reaches them. SSH from the node answers with an sshd banner |
| `hosted-db` | Passed, 483 migrations and 148 tests. Suite 1 min 57 s, whole run 2 min 3 s including a 4.4 s copy. GitHub's `ubuntu-26.04` runner took 2 min 35 s to 3 min 23 s for the same step, including the image pull (hosted-db runs 36368080589, 36367639772, 36371185370) |
| `test-office-storage-inventory-linux.mjs` | Passed. `npm ci` 30 s with a cold cache, suite 1.1 s |
| Docker | Rootful Docker 29.8.1 runs `hello-world` as `tester` |
| Nested KVM | `/dev/kvm` present, all 6 vCPUs show `svm`, `kvm_amd` loaded, `KVM_GET_API_VERSION` 12 and `KVM_CREATE_VM` succeed (the check from `deploy/first-node/verify-azure-step2-pilot-kvm.sh`). A 1 vCPU / 1 GiB Ubuntu 26.04 VM inside it answers `lxc exec` 25.8 s after launch; `systemctl is-system-running --wait` returns at 32.3 s |
| `scripts/*-systemd.mjs` | On master 65472c537 the office image suite stopped with "Disposable systemd manager did not start". At f9fc107f9 with images built as above, all six suites pass, plus `QORPERA_OFFICE_FIXTURE_LAYOUT_VERSION=2`, `--later-boot`, `--restart` and `test-runtime-office-start.mjs --boot-successor-systemd` (deleted in the legacy sweep). Suites 10 to 82 s, three runs at a time. At dc327a4ca the office image and observer suites also passed on Docker Desktop (arm64) with the same Dockerfile |
