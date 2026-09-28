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
| Image | Ubuntu 26.04 server, then Docker Engine (rootful), Node 24.21.0 (pinned checksum), Git, build tools, Python, LXD 6.9 rev 40424 for nested tests. The pinned PostgreSQL image of `scripts/test-hosted-db.mjs` and `node:24-bookworm-slim` are pre-pulled. Stopped containers, dangling images and build cache older than a week are pruned weekly |
| Self-update | `apt-daily*` and `unattended-upgrades` are masked, as for coding images (`deploy/coding-worker/COMMAND-GUEST.md`), and every snap is held |
| Network | Bridge `testmach0` (10.201.0.1/24, NAT, no IPv6), VM at 10.201.0.2 with MAC/IP filtering and port isolation |
| Egress | ACL `testmach-egress`: the internet only. Rejected: 10/8 except the bridge's own /24, 172.16/12, 192.168/16 (LAN and NAS), 100.64/10 (Tailscale), 169.254/16, 127/8, 0/8, 192.0.0/24, 198.18/15, 224/4 and all IPv6. The node itself (the gateway) is rejected on every TCP and UDP port except DNS and DHCP; ICMP to it is not blocked. LXD applies reject rules before allow rules, so the rejects are written to leave the needed holes rather than relying on allow rules |
| Ingress | Only SSH from the node (10.201.0.1). Developer sessions jump through the node's normal SSH login |
| Login | User `tester` (docker and passwordless sudo inside the VM), key only. Root login and passwords are off |

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
node scripts/run-on-node.mjs hosted-db
node scripts/run-on-node.mjs --env QORPERA_OFFICE_TEST_IMAGE=node:24-bookworm-slim scripts/test-office-storage-inventory-linux.mjs
node scripts/run-on-node.mjs --no-install -- docker run --rm hello-world
node scripts/run-on-node.mjs --dry-run npm:test:scripts
```

The wrapper copies the working tree git sees: tracked and untracked files that are not ignored,
uncommitted changes included, `node_modules` and `.git` left out. It copies them to a fresh
directory on the VM, and only changed files cross the network (rsync `--copy-dest` against a
per-worktree copy). It runs `npm ci --ignore-scripts` there (skipped for `hosted-db`, which needs
no packages), streams the output, and exits with the suite's exit code. The run directory is
deleted afterwards (`--keep` keeps it). At the start of every run, runs older than a day (by the UTC time
in their name), worktree copies unused for 14 days and hosted-db containers older than 6 hours are removed.
Untracked files that look like credentials (`.env`, `.env.*`, `*.env`, `.envrc`, `.npmrc`, `.netrc`, `.pgpass`,
`.git-credentials`, `.aws/credentials`, `*.pem`, `*.key`, `*.p12`, `*.tfvars`, `id_*` without an extension,
`credentials*.json`, `service-account*.json`, `*.private.json`) stop the run unless `--allow-secrets` is given.

The last line is a JSON record: host, OS, kernel, Node, npm, Docker and Git versions, KVM, source
commit and a digest of exactly the files copied, command, copy, preparation and elapsed time, and the
result (`passed`, `failed`, or `setup-failed` when `npm ci` failed). This
is the record contract 24.4 asks for. `--record FILE` also writes it to a file.

Several sessions can run at once. Each run has its own directory, and the hosted-db harness
names its containers per process.

Access needs the key `~/.ssh/id_ed25519_qorpera_testvm` and SSH to `company41-node-02`.
Override the target with `QORPERA_TEST_MACHINE`, `QORPERA_TEST_MACHINE_JUMP` and
`QORPERA_TEST_MACHINE_KEY`.

## The systemd suites

The `scripts/*-systemd.mjs` suites boot systemd as PID 1 in a disposable container and take a
digest-pinned local image in `QORPERA_OFFICE_SYSTEMD_TEST_IMAGE`: Ubuntu 26.04 with systemd, its Node 22
package and the executables the office image installer measures. Build it on the test machine
(about 90 s cold) and use the image ID the build prints. Every build prints a new ID, even from cache.
The tag keeps the current build out of the weekly prune of dangling images.

```sh
node scripts/run-on-node.mjs --no-install -- sh -c 'docker build -q -t qorpera-systemd-test:local - < scripts/fixtures/systemd-test-image.Dockerfile'
node scripts/run-on-node.mjs --env QORPERA_OFFICE_SYSTEMD_TEST_IMAGE=sha256:<id> scripts/test-office-image-installation-systemd.mjs
node scripts/run-on-node.mjs --env QORPERA_OFFICE_SYSTEMD_TEST_IMAGE=sha256:<id> scripts/test-office-service-stop-systemd.mjs -- --restart
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
| `scripts/*-systemd.mjs` | On master 65472c537 the office image suite stopped with "Disposable systemd manager did not start". At 9a13bb289 with the image built as above (`sha256:0e595c04…`), all six suites pass, plus `QORPERA_OFFICE_FIXTURE_LAYOUT_VERSION=2`, `--later-boot` and `--restart`. Suites 10 to 61 s, whole runs 17 to 89 s, three runs at a time. The office image and observer suites also pass on Docker Desktop (arm64) with the same Dockerfile |
