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
Untracked files that look like credentials (`.env*`, `*.env`, `.envrc`, `.npmrc`, `.netrc`, `.pgpass`,
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
