# Company machines

Machines are virtual machines that agents start themselves, for tests, builds, Docker stacks and long jobs (Jonas, 2026-09-28). The word follows the contract's wording: a computer is one agent's screen, and a machine is a VM. The coding machines and the company machines that host computers are separate things. So is this one.

An agent picks the size (CPUs, memory, disk). Inside, the agent's commands run as root, and Docker with Compose, Node, Python, Git and build tools are installed. A machine belongs to the company. Every member sees it and may stop, wake or delete it. Any agent of the company may use it. It holds no credential, it can reach the internet but none of our networks, and nothing reaches it from outside. Machines run on our own nodes only.

## What runs where

| Part | Where | What it does |
|---|---|---|
| SQL (`20260929050000_runtime_company_machines`) | the kernel | Machines, their disposable placements, commands and events; placement and admission on the shared node ledger (provider kind `machine`); the executor's custody of each placement; members' list and actions; `machine-event` wakes |
| `machine_*` tools (`packages/runtime/src/cloud-machine-tools.ts`) | the identity host, in a company conversation and in its agents' workers | start, run, read, cancel, stop, delete, list (a worker's start and read can wait) |
| Command route `/v1/machine-commands/*` (`cloud-machine-command-http.ts`) | the coding executor's ingress and peer listener | SQL authority, local execution or forwarding to the machine's node |
| Machine workload (`packages/runner-orchestrator/src/company-machine-host.ts`) | the coding executor on each node, a pass every 10 s | admit waiting machines; create, start, stop, delete them under the coding machine's journal (`company-machines/` on the NAS control path); keep each guest's lease; record how commands ended; report a busy guest |
| Guest helper (`packages/runtime/src/cloud-machine-guest.ts`) | `/opt/qorpera-machine/cloud-machine-guest.mjs` in the machine | commands as transient systemd units under `qorpera-machine.slice`, their retained intent and bounded logs on the machine's disk, and the watchdog |

### Lifetime

- **Placement.** A start places the machine on the node with the most room that fits it: processors and memory on the shared node ledger, and disk against the disk the node's pool gives machines (every placement that still exists counts its full disk, asleep or retired too). When the first machine in line lacks only disk that stopped machines hold on a node, their scratch disks are given up, the longest asleep first; they start fresh on their next wake. When no node fits it now, the machine waits, and every pass of every executor admits one waiting machine at a time. The build takes them in the order they asked, where they fit; the contract does not fix an order yet. A size larger than every node's largest machine or machine disk is refused at once. There are no prices, no priority rules and no count per company or agent.
- **Task machines** sleep once the node's idle delay has passed (default 1 hour) with no command running, no agent use and a quiet processor. Sleeping powers the VM off, frees its room and keeps its disk on that node for a wake there. The disk is scratch: a machine that wakes when its node is full or gone starts fresh as a new placement on another node, and its old node's executor deletes the old VM (Stateless Compute). A running machine never moves, nor one with a repository attached, nor one that asked for room under five minutes ago while its node has no usable observation. A task machine that never came up sleeps the same way and gives its room back. A task machine is removed after the node's removal delay asleep (default 30 days, like a quiet coding session's archive). The command is `qorpera_configure_machine_lifecycle(owner, sleepAfterSeconds, removeAfterSeconds)`.
- **Always-on machines** are never stopped or removed by the kernel.
- **A wake** (`machine_start` with the machine's name, or a member's Start) asks for room again, first on the node it slept on. A member's Start only puts it in line; the next pass gives it room. A machine asleep on a placement made before its node's machine policy changed (a new image) wakes fresh from the current image. One that still holds room keeps its old image, and restarts on it after a node reboot, until it sleeps or is stopped.
- **Workers** (an agent's background helpers, 2026-09-28) start and use machines like their agent, with the same authority, and their commands are their own. A worker has no conversation to continue, so nothing wakes it: it waits inside its run, up to 300 s a call and no model turn spent, while its machine starts (`machine_start` with `waitSeconds`) or until its command ends (`machine_read` with `waitSeconds`). It waits by looking every 5 s at the kernel's `status` (the machine's state and the command's end as the executor last recorded it, a pass every 10 s), it writes nothing, takes no machine lock (only the run's own authority check locks its job row) and never reaches the machine; the one read of the command's output comes after. To wait longer, the worker repeats the same call (same `operationKey`; `waitSeconds` may change). A cancelled worker, or a paused company, is told its work stopped and stops waiting. A machine waiting in line for room answers at once, and the worker reports that to its agent, which can retry. The kernel never puts a worker run on a machine's list of runs to tell and refuses a worker's command that asks to be notified (migration `20260929050500_runtime_machine_workers`). A conversation's machine card also shows the machines its agent's workers started.
- **Commands** have no deadline unless the agent sets one. They survive the agent's turn and stop when the machine stops. The executor watches every open command, and SQL records how it ended. A command started with `notify: true` wakes the run that started it once it ends. A machine that finished waiting wakes the runs that asked for it, unless they already used it; one that was stopped or deleted before it ran tells them so (kind `stopped`). The wake is a continuation in that run's conversation (source `machine-event`), like a worker's report.
- **Crash detection.** The executor renews a 15-minute lease in the guest every pass, also while SQL refuses new room (a node that looks unavailable, or machines switched off): only creating or starting needs room. The watchdog timer stops `qorpera-machine.slice` when the lease runs out. The lease is long on purpose, so jobs of hours outlive an executor restart or a release cut. Root in the guest can switch the watchdog off. The VM is the boundary, and the executor powers machines off from outside whenever SQL wants them stopped.
- **What LXD shows settles the rest.** A machine's VM keeps nothing of its own, so the executor settles from LXD's view what its journal cannot. A VM that stopped by itself (a `poweroff` inside, a node reboot) is stopped, then started again, put to sleep or deleted as SQL wants. A failed create or start is tried again up to three times. An operation LXD forgot after an LXD restart is settled from the VM at once, and an effect it never confirmed (an executor stopped mid-request, a refused request) is settled ten minutes later.

### What a machine can reach

`setup-machine-network.sh` creates the machine network (default `machine-net`, `10.88.0.1/22`). It is a NAT bridge with IPv4 only and an ACL that drops these destinations:

- 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4 and 240/4;
- except two addresses, left out of those ranges by exact CIDRs (61 ranges, plus 2 rules for the gateway's ports): the bridge's gateway, where TCP and UDP are open only for DNS (53) and DHCP (67) (ICMP to it is not dropped), and 255.255.255.255, where a DHCP discover goes.

LXD applies drop and reject rules before allow rules, and its baseline DHCP and DNS allowances do not open a hole in them (seen on node 2, `deploy/test-machine/README.md`). An ACL that drops 10/8 or 240/4 whole leaves machines without an address; the script refuses one it finds (replace it: `lxc network unset <network> security.acls && lxc network acl delete <network>-egress`, then run the script again).

Together these cover the NAS and the node LAN, Tailscale, cloud metadata, the other bridges and the node itself. Other outbound traffic is allowed and all inbound is dropped. Each machine's NIC carries MAC and IPv4 filtering and port isolation, so machines on the bridge cannot reach each other. Offices refuse networks with ACLs, so this network is used by machines only.

### Proof on node 2 (2026-09-29)

Run inside node 2's operator test VM with nested LXD 6.9 (`deploy/test-machine/README.md`), so nothing on node 2's own LXD changed. It ran the real `setup-machine-network.sh`, `build-machine-image.sh` and `prove-machine-node.ts`, which runs the executor's journaled lifecycle, guest helper and commands with an in-memory kernel. A loopback NFSv4 export stood in for the NAS. The image was built by the build script as of f6b25e9d5, before its stdout fix: the record was taken from the end of its output. The fixed `> image-build.json` flow was checked in a container, not on LXD.

| Check | Result |
| --- | --- |
| Network | The bridge and 63-rule ACL came up as designed. Machines got their address by DHCP and resolved names (the bridge's dnsmasq is their only resolver) |
| Image | Built in 243 s (Ubuntu 26.04, Docker 29, Compose 2.40.3, Node 24.21.0), 1.1 GiB in `lxc image list`; its own checks passed |
| Machine | 4 CPUs, 8 GiB, 40 GiB disk, usable 63 s after the first pass |
| Docker | `hello-world` as root, and a Compose stack (Postgres, healthcheck, `psql`) up and down |
| Out | HTTPS to github.com works, and a TCP connect to 1.1.1.1:443 succeeds |
| Dropped (TCP connect times out) | The bridge gateway's SSH, the test VM's own and node 2's SSH, another bridge's DNS, the NAS (22, 2049), cloud metadata, Tailscale. A timeout proves a drop only where something would otherwise answer: the first three have listeners, and the test VM's own ACL rejects the rest (a fast refusal), so each timeout here is this ACL's drop. On a bare node, pick targets that answer or refuse from the node |
| Qorpera | `npm ci` and `npm run test:hosted-db` inside the machine: 471 migrations and 137 tests passed |
| Delete | A running `sleep 3600` stopped with the machine, which was deleted and released |

Nested KVM also works inside a machine (`/dev/kvm`, `svm` on every CPU). Docker's default AppArmor profile blocks remounting `/sys/fs/cgroup` read-write, so a container that runs systemd needs `--security-opt apparmor=unconfined` (the test machine's note).

### A coding session's repository

`machine_start` with `repositoryWorker` attaches the session's repository folder read-only at `/mnt/repository`. The machine is then placed on the node whose NAS holds that session. Agents copy the repository to the machine's own disk before building, so `node_modules` and Docker layers never land on the NAS.

## Install on a node

The steps below need root on the node and a maintenance window. The coordinator runs them in a release cut.

1. **Package the guest** from a checkout whose `npm run check` passes:
   `node scripts/package-machine-guest.mjs --out /task-owned/machine-guest`. The helper must stay under 64 KiB, because the executor re-reads it to check its pin.
2. **Create the project and the network** on the node:
   - `lxc project create machines -c features.images=false -c features.profiles=false`
   - `deploy/machine/setup-machine-network.sh machine-net 10.88.0.1/22`
   - Keep the printed network and ACL as evidence.
   - The storage pool is the node's VM pool (ZFS), for example `qorpera-vm`. Machines get their own root disks.
   - The host must forward the bridge's traffic. Node 2 runs no Docker (checked 2026-09-29). On a host that does, Docker sets the FORWARD policy to drop, and machines resolve names but reach nothing. Allow the bridge there (`iptables -I DOCKER-USER -i machine-net -j ACCEPT` and `iptables -I DOCKER-USER -o machine-net -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT`, repeated after a reboot). The ACL still applies, because LXD's rules live in their own table.
3. **Build the image** in a quiet window. The builder VM makes the node "unavailable" until it is deleted.
   `deploy/machine/build-machine-image.sh /task-owned/machine-guest <node-version> <node-sha256> machines machine-net > image-build.json`
   Take the Node.js tarball's sha-256 from nodejs.org's `SHASUMS256.txt`.
4. **Compute the policy.**
   `node scripts/machine-provider-policy.mjs image-build.json <executor owner> <node id> <machine-id sha256> <coding providerId> <max cpus> <max memory GiB> <machine disk GiB> machines <pool> machine-net`
   - The provider id must be the coding executor's `vmPolicy.providerId`, because command routing reuses the coding peers.
   - The largest machine must fit the node's budget. `qorpera_enroll_runtime_node_provider` refuses more.
   - The machine disk is what the pool may promise machines in total (ZFS volumes are sparse, so leave the node's own VMs their share).
   - After a new image, keep the earlier helper's sha-256 in the block's `previousHelperSha256s` while any placement from that image still holds room (running or starting). Those machines keep their lease, and they wake fresh from the new image after they sleep or are stopped. Always-on machines keep the old helper needed until someone stops them; the block takes at most 16 earlier helpers.
5. **Configure the executor.**
   - Add the printed `machines` block to the executor's configuration (`qorpera.coding-executor-service/v7`).
   - Restart the executor while it is drained.
   - Run the two printed SQL statements as service role.
   - An executor without a `machines` block makes no machines, but still forwards machine commands to its peers.
6. **Roll the observer.** Roll the node observer build that knows `qorpera.lxd-company-machine/v1` before the first machine. An older observer marks the node unavailable when it meets one.

Rollback:
- `qorpera_configure_machine_executor(owner, sha, false, policy, diskBytes)` stops admission. Running machines keep their leases.
- Stop and delete the node's machines with the members' action or the agent tool. Their allocations are released only by the executor's proven delete.
- A node gone for good: disable its executor, then run `qorpera_abandon_machine_executor(owner, sha)` as service role once its disks are known to be gone. It releases the node's placements; their machines start fresh elsewhere on the next wake, and deleted ones finish.

## Acceptance (node 2)

1. An agent starts a 4-CPU / 8 GiB task machine.
2. `machine_run "docker run --rm hello-world && docker compose version"` succeeds.
3. From the machine, `curl https://github.com` works, while `curl 192.168.0.206`, a Tailscale address, `169.254.169.254` and the bridge gateway's other ports all time out.
4. With a coding session attached, the agent runs `cp -a /mnt/repository /root/repo && cd /root/repo && npm ci --ignore-scripts && npm run test:hosted-db` with `notify: true`. It ends its turn and is woken with the result.
5. Kept as evidence:
   - The inventory shows the machine as managed and the node stays `ready` throughout.
   - The machine sleeps after the idle delay and wakes by name.
   - A second machine that does not fit waits with a place in line and starts when the first one sleeps.
   - A delete releases the allocation.
