# Company machines

Machines are virtual machines that agents start themselves, for tests, builds, Docker stacks and long jobs (Jonas, 2026-09-28). The word follows the contract's wording: a computer is one agent's screen, and a machine is a VM. The coding machines and the company machines that host computers are separate things. So is this one.

An agent picks the size (CPUs, memory, disk). Inside, the agent's commands run as root, and Docker with Compose, Node, Python, Git and build tools are installed. A machine belongs to the company. Every member sees it and may stop, wake or delete it. Any agent of the company may use it. It holds no credential, it can reach the internet but none of our networks, and nothing reaches it from outside. Machines run on our own nodes only.

## What runs where

| Part | Where | What it does |
|---|---|---|
| SQL (`20260928153000_runtime_company_machines`) | the kernel | Machines, their disposable placements, commands and events; placement and admission on the shared node ledger (provider kind `machine`); the executor's custody of each placement; members' list and actions; `machine-event` wakes |
| `machine_*` tools (`packages/runtime/src/cloud-machine-tools.ts`) | the identity host, in a company conversation | start, run, read, cancel, stop, delete, list |
| Command route `/v1/machine-commands/*` (`cloud-machine-command-http.ts`) | the coding executor's ingress and peer listener | SQL authority, local execution or forwarding to the machine's node |
| Machine workload (`packages/runner-orchestrator/src/company-machine-host.ts`) | the coding executor on each node, a pass every 10 s | admit waiting machines; create, start, stop, delete them under the coding machine's journal (`company-machines/` on the NAS control path); keep each guest's lease; record how commands ended; report a busy guest |
| Guest helper (`packages/runtime/src/cloud-machine-guest.ts`) | `/opt/qorpera-machine/cloud-machine-guest.mjs` in the machine | commands as transient systemd units under `qorpera-machine.slice`, their retained intent and bounded logs on the machine's disk, and the watchdog |

### Lifetime

- **Placement.** A start places the machine on the node with the most room that fits it, and it stays on that node. When no node fits it now, the machine waits in line, and every pass of every executor tries the waiting machines in order ("first come, first served where it fits"). A size larger than every node's largest machine is refused at once. There are no prices, no priority rules and no count per company or agent.
- **Task machines** sleep once the node's idle delay has passed (default 1 hour) with no command running, no agent use and a quiet processor. Sleeping powers the VM off, frees its room and keeps its disk on that node for a wake there. The disk is scratch: a machine that wakes when its node is full or gone starts fresh as a new placement on another node, and its old node's executor deletes the old VM (Stateless Compute). A running machine, or one whose node only missed its observations for under five minutes, never moves. A task machine is removed after the node's removal delay asleep (default 30 days, like a quiet coding session's archive). The command is `qorpera_configure_machine_lifecycle(owner, sleepAfterSeconds, removeAfterSeconds)`.
- **Always-on machines** are never stopped or removed by the kernel.
- **A wake** (`machine_start` with the machine's name, or a member's Start) asks for room again on the machine's own node.
- **Commands** have no deadline unless the agent sets one. They survive the agent's turn and stop when the machine stops. The executor watches every open command, and SQL records how it ended. A command started with `notify: true` wakes the run that started it once it ends. A machine that finished waiting wakes the run that asked for it, unless that run already used it. The wake is a continuation in that run's conversation (source `machine-event`), like a worker's report.
- **Crash detection.** The executor renews a 15-minute lease in the guest every pass. The watchdog timer stops `qorpera-machine.slice` when the lease runs out. The lease is long on purpose, so jobs of hours outlive an executor restart or a release cut. Root in the guest can switch the watchdog off. The VM is the boundary, and the executor powers machines off from outside whenever SQL wants them stopped.

### What a machine can reach

`setup-machine-network.sh` creates the machine network (default `machine-net`, `10.88.0.1/22`). It is a NAT bridge with IPv4 only and an ACL that drops these destinations:

- 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4 and 240/4.

Together these cover the NAS and the node LAN, Tailscale, cloud metadata, the other bridges and the node itself. Other outbound traffic is allowed and all inbound is dropped. Each machine's NIC carries MAC and IPv4 filtering and port isolation, so machines on the bridge cannot reach each other. Offices refuse networks with ACLs, so this network is used by machines only.

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
3. **Build the image** in a quiet window. The builder VM makes the node "unavailable" until it is deleted.
   `deploy/machine/build-machine-image.sh /task-owned/machine-guest <node-version> <node-sha256> machines machine-net > image-build.json`
   Take the Node.js tarball's sha-256 from nodejs.org's `SHASUMS256.txt`.
4. **Compute the policy.**
   `node scripts/machine-provider-policy.mjs image-build.json <executor owner> <node id> <machine-id sha256> <coding providerId> <max cpus> <max memory GiB> machines <pool> machine-net`
   - The provider id must be the coding executor's `vmPolicy.providerId`, because command routing reuses the coding peers.
   - The largest machine must fit the node's budget. `qorpera_enroll_runtime_node_provider` refuses more.
5. **Configure the executor.**
   - Add the printed `machines` block to the executor's configuration (`qorpera.coding-executor-service/v7`).
   - Restart the executor while it is drained.
   - Run the two printed SQL statements as service role.
   - An executor without a `machines` block makes no machines, but still forwards machine commands to its peers.
6. **Roll the observer.** Roll the node observer build that knows `qorpera.lxd-company-machine/v1` before the first machine. An older observer marks the node unavailable when it meets one.

Rollback:
- `qorpera_configure_machine_executor(owner, sha, false, policy)` stops admission.
- Stop and delete the node's machines with the members' action or the agent tool. Their allocations are released only by the executor's proven delete.

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
