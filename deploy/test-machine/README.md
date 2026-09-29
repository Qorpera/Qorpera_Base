# Operator test machine on node 2

One virtual machine on `company41-node-02` runs Qorpera's own SQL and Linux test suites,
instead of Docker on a developer Mac (contract 24.1: runtime verification uses the Linux
runtime-hosting machines). It is operator infrastructure. It holds no company data, no
credentials and no product role. Agents' test machines (#419) are a separate product feature.

## What it is

| Item | Value |
| --- | --- |
| VM | `qorpera-testvm-node02` in LXD project `testmachines` |
| Size | 6 vCPU, 16 GiB RAM, 150 GiB root disk on pool `qorpera-vm`. Sized for PR #326's physical acceptance (6+ CPUs, 16 GiB, KVM). Setup records whether `/dev/kvm` is present |
| Image | Ubuntu 26.04 server, then [`guest-setup.sh`](guest-setup.sh): Docker Engine (rootful), Node 24.21.0 (pinned checksum), Git, build tools, Python, bubblewrap, LXD 6.9 rev 40424 for nested tests. The pinned PostgreSQL image of `scripts/test-hosted-db.mjs`, `node:24-bookworm-slim` and `node:22-bookworm-slim` (the runtime office probes, as in CI) are pre-pulled. Stopped containers, dangling images and build cache older than a week are pruned weekly |
| Self-update | `apt-daily*` and `unattended-upgrades` are masked, as for coding images (`deploy/coding-worker/COMMAND-GUEST.md`), and every snap is held |
| Network | Bridge `testmach0` (10.201.0.1/24, NAT, no IPv6), VM at 10.201.0.2 with MAC/IP filtering and port isolation |
| Egress | ACL `testmach-egress`: the internet only. Rejected: 10/8 except the bridge's own /24, 172.16/12, 192.168/16 (LAN and NAS), 100.64/10 (Tailscale), 169.254/16, 127/8, 0/8, 192.0.0/24, 198.18/15, 224/4 and all IPv6. The node itself (the gateway) is rejected on every TCP and UDP port except DNS and DHCP; ICMP to it is not blocked. LXD applies reject rules before allow rules, so the rejects are written to leave the needed holes rather than relying on allow rules |
| Ingress | Only SSH from the node (10.201.0.1). Developer sessions jump through the node's normal SSH login |
| Login | User `tester` (docker and passwordless sudo inside the VM), key only. Root login and passwords are off |
| Runner users | `ci01` to `ci16`, same rights as `tester`. Each run takes a free one for its whole duration (below) |

## Node accounting

Every LXD instance on a node must be a registered allocation or enrolled infrastructure,
otherwise the node reports `unavailable` (`deploy/first-node/RUNTIME-HOST-INVENTORY.md`). The
VM is enrolled exactly as infrastructure (`NODE-BUILDER-COEXISTENCE.md`, "Exact builder
enrollment"). Node 2's headroom covers operating + execution host + build space + this VM:
20000 mCPU / 64 GiB. The VM's 6000 mCPU / 16 GiB is charged whether it runs or not, so node 2's
placement budget is permanently that much smaller. `boot.autostart` is `false`: after a node
reboot the VM stays stopped until an operator starts it.

The enrollment pins the VM's physical UUID and configuration digest. Changing its LXD
configuration, devices or limits, or rebuilding it, needs a new enrollment under an admission
hold, run or reviewed by the coordinator. Work inside the guest (packages, Docker images, files)
does not change the digest.

## Running a suite

```sh
node scripts/run-on-node.mjs changed
node scripts/run-on-node.mjs test
node scripts/run-on-node.mjs hosted-db
node scripts/run-on-node.mjs --env QORPERA_OFFICE_TEST_IMAGE=node:24-bookworm-slim scripts/test-office-storage-inventory-linux.mjs
node scripts/run-on-node.mjs --no-install -- docker run --rm hello-world
node scripts/run-on-node.mjs --dry-run npm:test:scripts
```

`changed` is the everyday check: it runs what the files changed against `origin/master` (or `--base REF`)
need, and prints what it chose and why. The steps and the paths that start them are in
[`scripts/run-on-node-plan.mjs`](../../scripts/run-on-node-plan.mjs); they replace the path filters of the
switched-off GitHub workflows. Documentation alone runs nothing; shared configuration (`package.json`, the
lockfile, `tsconfig`, `vitest.base.ts`, `biome.json`, `packages/contracts`, `packages/company`) and any path no
step covers run the whole `npm test`. Every step runs even when an earlier one fails. The full `test` suite is
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

At most three runs execute at once, and each runs vitest with `VITEST_MAX_WORKERS=2` (a `--env
VITEST_MAX_WORKERS=n` on the command wins). Three runs times two workers matches the 6 vCPUs. A full
`npm test` is about 881 CPU-seconds; on 2026-09-29 two full runs plus other sessions drove the load to 22
and timing-bound tests failed that pass on a quiet machine. Later runs wait in arrival order and print
their queue position; the record notes the slot and the time spent queued. Each runner user keeps its own npm cache, so
`npm ci` takes about 30 s the first time and 5-6 s after that. The run directory is
deleted afterwards (`--keep` keeps it). At the start of every run, runs older than a day (by the UTC time
in their name), worktree copies unused for 14 days and hosted-db containers older than 6 hours are removed.
Untracked files that look like credentials (`.env`, `.env.*`, `*.env`, `.envrc`, `.npmrc`, `.netrc`, `.pgpass`,
`.git-credentials`, `.aws/credentials`, `*.pem`, `*.key`, `*.p12`, `*.tfvars`, `id_*` without an extension,
`credentials*.json`, `service-account*.json`, `*.private.json`) stop the run unless `--allow-secrets` is given.

The last line is a JSON record: host, OS, kernel, Node, npm, Docker and Git versions, KVM, source
commit and a digest of exactly the files copied, command, copy, preparation and elapsed time, and the
result (`passed`, `failed`, or `setup-failed` when `npm ci` or the build failed), and the runner user. This
is the record contract 24.4 asks for. `--record FILE` also writes it to a file.

Several sessions can use the machine at once. Each run has its own directory and runner user, and the
hosted-db harness names its containers per process.

Access needs the key `~/.ssh/id_ed25519_qorpera_testvm` and SSH to `company41-node-02`.
Override the target with `QORPERA_TEST_MACHINE`, `QORPERA_TEST_MACHINE_JUMP` and
`QORPERA_TEST_MACHINE_KEY`.

## Proof (2026-09-28, VM enrolled at node 2 version 23)

| Check | Result |
| --- | --- |
| Network | Lease, DNS and HTTPS work. The NAS (192.168.1.40:22, :2049), a Tailscale peer, node 2's LAN and Tailscale addresses, the router, and the gateways of this and two other bridges are refused from the VM while node 2 itself reaches them. SSH from the node answers with an sshd banner |
| `hosted-db` | Passed, 483 migrations and 148 tests. Suite 1 min 57 s, whole run 2 min 3 s including a 4.4 s copy. GitHub's `ubuntu-26.04` runner took 2 min 35 s to 3 min 23 s for the same step, including the image pull (hosted-db runs 36368080589, 36367639772, 36371185370) |
| `test-office-storage-inventory-linux.mjs` | Passed. `npm ci` 30 s with a cold cache, suite 1.1 s |
| Docker | Rootful Docker 29.8.1 runs `hello-world` as `tester` |
| Nested KVM | `/dev/kvm` present, all 6 vCPUs show `svm`, `kvm_amd` loaded, `KVM_GET_API_VERSION` 12 and `KVM_CREATE_VM` succeed (the check from `deploy/first-node/verify-azure-step2-pilot-kvm.sh`). A 1 vCPU / 1 GiB Ubuntu 26.04 VM inside it answers `lxc exec` 25.8 s after launch; `systemctl is-system-running --wait` returns at 32.3 s |

**Known limit: the `scripts/*-systemd.mjs` suites.** They remount `/sys/fs/cgroup` read-write to boot
systemd in a container. Docker's default AppArmor profile on Ubuntu refuses that mount ("cgroup is
write-protected"), so as written they fail here and on any Ubuntu Docker host. They have only run on
Docker Desktop, which has no AppArmor. The same container with `--security-opt apparmor=unconfined`
boots systemd in under a second. They also need prepared, digest-pinned local images.
