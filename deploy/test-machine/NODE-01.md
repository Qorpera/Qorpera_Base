# A second test machine on node 1

Design note and coordinator runbook, 2026-10-03. The README describes the machines and the wrapper; this file
says why node 1 gets one, how big, what it costs node 1, and how it is built, enrolled and removed.

## Why

Since 2026-10-03 every test and check runs on node 2's test machine (nothing heavy on a developer Mac), and it
is the bottleneck. At 05:28Z a 10-second command waited 615 s, starting at queue position 10 behind 3 running
suites; at 05:50Z the queue was 12 deep. Node 2's load was 4-5 on 10 vCPUs, so the queue, not the CPU, sets
the wait. Node 1 is nearly idle: load 0.5, 17 of 122 GiB used (05:23Z).

## Size: the same as node 2's

10 vCPU, 16 GiB, 150 GiB root disk on `qorpera-vm`, the same Ubuntu 26.04 image (`5e644adaf5d1`) and the same
`guest-setup.sh`.

- Same vCPUs, same vitest workers per run (10 / 3 = 3): a suite behaves the same on either machine. Timing-bound
  tests have failed before on a loaded machine; two machines that differ would make a result depend on which
  one a run landed on.
- Memory measured on node 2 (since its 2026-09-29 resize, 3 runs at a time): runs peaked at 13.8 GiB
  (`user.slice` `memory.peak`, page cache included), no out-of-memory kill in 5 days, memory pressure near
  zero. 12 GiB would be tight.
- Disk on node 2: 64 of 145 GB used (worktree copies 17 GB, Docker volumes 15.6 GB that a prune frees).
- Nested KVM: node 1 has `kvm_amd` `nested=1`, the same hardware as node 2.

## What it costs node 1

Production, read 2026-10-03 05:2xZ: node 1 (`native25-phql-a1`, `03ad8f14-6089-48d2-abb4-60566c0b9ce0`) is
version 34, 32000 mCPU, 122.6 GiB, CPU allocation ratio 2, standard slot 8000 mCPU / 16 GiB. Headroom 4000 mCPU /
32 GiB covers the operating allowance (2000 / 24 GiB) and `company41-orchestrator-01` (2000 / 2 GiB); 6 GiB of it
is unassigned. Node 2 is at its maximum headroom, 24000 / 64 GiB.

A tenant slot holds the company machine (Qorpera's Company Computer, 8/16) or an overflow fresh-VM run. Free
slots = min((32000 - headroom CPU) x 2 / 8000, (122.6 GiB - headroom memory) / 16 GiB), rounded down:

| Node 1 | Headroom | CPU slots | Memory slots | Slots |
| --- | --- | --- | --- | --- |
| today | 4000 / 32 GiB | 7 | 5 | **5** |
| + test machine (10000 / 16 GiB) | 14000 / 48 GiB | 4 | 4 | **4** |
| + the planned fast host (4 slots, 4000 / 12 GiB) | 18000 / 60 GiB | 3 | 3 | **3** |
| fast host only, for comparison | 8000 / 44 GiB | 6 | 4 | **4** |

With both, node 1 keeps 3 tenant slots (the company machine and two overflow VMs) and node 2 has 2. Ordinary
turns go to the two fast hosts (4 slots each); a fresh VM on node 1 starts only when every fast host refused.
The node row check `standard_cpu_millis <= cpu_millis - headroom_cpu_millis` holds: 8000 <= 18000 with the test
machine, 8000 <= 14000 with both.

The order does not matter: each step raises the headroom by its own size. A smaller machine buys nothing back
once the fast host is there: memory then allows 3 slots whatever the vCPUs. The fourth slot comes back only
with 8 vCPU and a +10 GiB raise that uses node 1's unassigned 6 GiB; that is the coordinator's call, and these
steps do not take it.

## How a run picks a machine

One run, one machine, chosen at the start (README, "Which machine"):

- The wrapper asks both machines at once, read-only, how many of their 3 slots runs hold, how many runs wait in
  their queue and how many are still being copied there (a marker per run until it takes a queue ticket, so a
  burst of starts spreads out). It takes the one with the most free slots, counting waiting and arriving runs
  against them; on a tie, node 2. A probe answers in about a second; its connection must reach the machine's SSH
  within 6 s, and once one machine has answered with a free slot the other gets 2 s more. A machine that did not
  answer is tried last: a probe's budget is short, and the copy's own connection may still get through.
- If the chosen machine fails before the suite starts (the first SSH call or the copy), the next one takes the
  run, after the event loop has had a turn: a copy an interrupt ended stops the run instead of moving it. A
  started suite is never repeated elsewhere.
- `--machine node01|node02` pins a machine. A machine is closed to the automatic choice by the file
  `/etc/qorpera-test-machine-closed` inside it (maintenance, removal), and until `guest-setup.sh` has finished;
  `--machine` still reaches it.

Least busy rather than a fixed share: the queue length is the cost a session feels, and a fixed share would
send runs to a full machine while the other idles. A shared queue across machines would need a coordinator
process; each machine keeps its own arrival-ordered queue instead, and the probe makes a run join the shorter
one.

## The 3-slot cap and statuses per machine

The script that runs on a machine is unchanged, so everything it enforces is per machine: 3 slots in arrival
order, `VITEST_MAX_WORKERS` = vCPUs / 3, runner users `ci01`-`ci16`, its own npm caches and worktree copies. Two
machines run 6 suites at once. The GitHub status context stays `qorpera-ci/<suite>` on either machine; the
description names it ("passed on node 1 in 6m12s"), and so does the pending one. The run record gains `machine`,
`machines` (every probe's answer), `probeSeconds` and `passedOver`.

The wrapper can be merged before node 1's machine exists: node 1 then shows as unreachable and every run goes to
node 2. That costs a run little: node 1's jump usually refuses at once ("Network is unreachable"); when it hangs,
the run waits 2 s past node 2's answer if node 2 has a free slot, and up to 6 s if node 2 is full (12 s is the
hard limit). Clients that have not merged it send everything to node 2. A new machine counts as closed until
`guest-setup.sh` has finished, and the runbook keeps it closed until it is proven.

## Runbook (coordinator)

The coordinator runs every step on node 1, as for node 2 on 2026-09-28 (registry 21:26Z: preflight, drain,
settle, enroll, serve, start, setup). `N1` = `03ad8f14-6089-48d2-abb4-60566c0b9ce0`. LXD commands run as root on
`company41-node-01`; give every `lxc … create` and `lxc init` its own stdin (`</dev/null` or a file): they read
YAML from a stdin that is not a terminal. SQL runs as the service role. Pick a quiet time: node 1 takes no new
work from step 2 to step 6 (minutes). If node 1's fast host is due too, one hold can carry both: raise the
headroom by both sizes and enroll both entries in one policy replace.

### 0. Preflight (read-only)

- SQL: node 1's row (`version`, `headroom_cpu_millis`, `headroom_memory_bytes`, `enabled`, `runs_enabled`), its
  latest stored policy (`qorpera_runtime_node_policies`, highest version; it carries `cpuAllocationRatio`), and its
  inventory policy and digest (`qorpera_runtime_node_inventory_policies`; `e2e4a51f…` at 05:2xZ). Save that
  inventory policy JSON: if a step fails inside this hold, it is still the current one and goes back. `qorpera_runtime_node_drain_status('<N1>')` (inside
  `begin … rollback`).
- `op --node node01 observer-check`: `observerNodeId` is `N1`, `observerHoldsDatabasePolicy` true.
- Node 1 (root): `lxc project list`, `lxc network list` and `lxc network acl list` show no `testmachines`,
  `testmach0` or `testmach-egress`; `lxc storage info qorpera-vm` has more than 160 GiB free;
  `lxc image info 5e644adaf5d1` (step 1 if missing); `G check` (`G` =
  `/usr/local/libexec/qorpera-guest-guard/qorpera-guest-guard.sh`) and the mode in
  `/etc/qorpera-guest-guard/mode` (the guard's rules already list `testmach0` 10.201.0.0/24 and gateway 10.201.0.1).
- Node 2 (read-only; the admin login is in group `lxd` there): save the three definitions node 1 copies.

  ```sh
  lxc project show testmachines > testmachines.yaml
  lxc network show testmach0 > testmach0.yaml
  lxc network acl show testmach-egress > testmach-egress.yaml
  ```

  Expected (read 2026-10-03): the project is restricted (`restricted.devices.disk` and `.nic` managed,
  `restricted.networks.access` `testmach0`, `restricted.virtual-machines.lowlevel` block), with
  `features.images` and `features.networks` false, `limits.containers` 0, `limits.cpu` 10, `limits.memory`
  16GiB, `limits.disk` 160GiB. The bridge is `ipv4.address` 10.201.0.1/24, `ipv4.nat` true, `ipv6.address`
  none, `security.acls` testmach-egress, default egress allow, default ingress reject. The ACL has 28 egress
  rejects (all of 10/8 except 10.201.0.0/24, 172.16/12, 192.168/16, 100.64/10, 169.254/16, 127/8, 0/8,
  192.0.0/24, 198.18/15, 224/4, ::/0, and the gateway 10.201.0.1 on every TCP port but 53 and every UDP port but
  53 and 67) and one ingress allow: TCP 22 from 10.201.0.1. Nothing in them names a node, so node 1 takes them
  as they are.

### 1. Image (no hold needed)

If node 1 lacks `5e644adaf5d1`: export it on node 2 (`lxc image export 5e644adaf5d1 /var/tmp/ubuntu-2604`), carry
the two files to node 1 the way cut lanes carry runner images, `lxc image import <metadata> <rootfs> </dev/null`,
check the fingerprint, and delete the copies. `ubuntu:26.04` is the fallback; then record its fingerprint
(`guest-setup.sh` upgrades packages either way).

### 2. Hold

```sql
select public.qorpera_set_runtime_node_serving('<N1>'::uuid, false,
  (select version from public.qorpera_runtime_nodes where id = '<N1>'), 'test machine on node 1');
```

New runs, sign-ins and machine wakes for node 1 wait; work already there continues. Wait for `drain_status`
`readyForRestart`, as for node 2. If an awake company computer keeps it false, `readyForUpdate` is enough for
these steps (no host or LXD restart); that is the coordinator's call.

### 3. Headroom

`qorpera_configure_runtime_node(<policy>, <current version>)` with the latest stored policy, `headroomCpuMillis`
+10000, `headroomMemoryBytes` +17179869184, and `"enabled": false` (step 2 left the stored policy at `false`; the
step-0 copy says `true`, and sending that would end the hold). Today: 4000 → 14000 and 34359738368 → 51539607552. The node version goes up by one. A refusal
("would discard occupied capacity") means node 1 holds more than the new budget allows: undo step 2 and wait.

### 4. Create (node 1, root)

```sh
lxc network acl create testmach-egress </dev/null && lxc network acl edit testmach-egress < testmach-egress.yaml
lxc network create testmach0 --type=bridge ipv4.address=10.201.0.1/24 ipv4.nat=true ipv6.address=none \
  security.acls=testmach-egress security.acls.default.egress.action=allow security.acls.default.ingress.action=reject </dev/null
lxc network edit testmach0 < testmach0.yaml
lxc project create testmachines </dev/null && lxc project edit testmachines < testmachines.yaml
lxc init 5e644adaf5d1 qorpera-testvm-node01 --vm --project testmachines --no-profiles --storage qorpera-vm \
  -d root,size=150GiB -c limits.cpu=10 -c limits.memory=16GiB -c boot.autostart=false \
  -c "user.test-machine-purpose=Qorpera own test suites; second operator test VM, 2026-10-03" </dev/null
lxc config device add qorpera-testvm-node01 eth0 nic network=testmach0 name=eth0 ipv4.address=10.201.0.3 \
  security.mac_filtering=true security.ipv4_filtering=true security.ipv6_filtering=true \
  security.port_isolation=true --project testmachines
```

The root disk gets its size in the create itself: the project's `limits.disk` refuses an instance whose root
device has no size. The bridge is created with its final settings in one call, so the guard never sees a
`testmach0` with IPv6.
Then compare with node 2: `lxc config show qorpera-testvm-node01 --project testmachines` must differ from node 2's
only in name, `ipv4.address`, the purpose text and `volatile.*`; `lxc network acl show`, `lxc network show` and
`lxc project show` only in `used_by`. `G check` must print `bridge testmach0: matches` (and `G verify` exit 0
when the guard enforces). The VM stays
stopped; node 1's observer reports `unavailable` from `lxc init` until step 5 (the hold covers it).

### 5. Enroll

As for node 2's VM (`NODE-BUILDER-COEXISTENCE.md`, "Exact builder enrollment", steps 4-5):

1. A fresh complete inventory and `qorpera_runtime_node_inventory_context('<N1>')`, under the hold.
2. The entry: `project` testmachines, `name` qorpera-testvm-node01, `physicalId` = its `volatile.uuid`, `type`
   virtual-machine, `configurationSha256` = `runtimeNodeInstanceConfigurationSha256`
   (`packages/runner-orchestrator/src/runtime-node-inventory.ts`) over its local and effective config, devices and
   profiles, `cpuMillis` 10000, `memoryBytes` 17179869184.
3. `node scripts/prepare-node-builder-inventory.mjs private-input.json plan.json` (input: the context, the
   inventory, the previous inventory digest, the entry). It refuses a running VM, `boot.autostart` true, any
   `user.qorpera.*` key and a budget over the headroom. Review: one new entry; operating plus infrastructure is
   2000 + 2000 + 10000 = 14000 mCPU and 24 + 2 + 16 = 42 GiB, within 14000 / 48 GiB.
4. In one transaction: lock node 1's row and its inventory policy row, check node 1 is still not serving and its
   version and inventory digest are what step 3 left, then `qorpera_replace_runtime_node_inventory(<plan policy>,
   '<previous digest>')`. Keep the receipt.
5. `op --node node01 observer-sync`, then wait for a fresh `ready` observation at the current version.

### 6. Serve

```sql
select public.qorpera_set_runtime_node_serving('<N1>'::uuid, true,
  (select version from public.qorpera_runtime_nodes where id = '<N1>'), 'test machine on node 1');
```

Check node 1 `serving` and `runsServing` (drain status) and that its observer stays `ready` once the VM runs.

### 7. Start and set up (node 1, root)

```sh
lxc start qorpera-testvm-node01 --project testmachines
for i in $(seq 60); do lxc exec qorpera-testvm-node01 --project testmachines -- true 2>/dev/null && break; sleep 2; done
lxc exec qorpera-testvm-node01 --project testmachines -- sh -c 'echo "being set up and proven (NODE-01.md 7-9)" > /etc/qorpera-test-machine-closed'
sha256sum guest-setup.sh   # 02c883215bd5302253f3345d98ec1816e2ec7ef95b0dade95326afc579993cfa at this change
lxc exec qorpera-testvm-node01 --project testmachines -- bash -s -- "<public key>" < guest-setup.sh
```

Close it first: from the moment setup installs the key, every developer's probe reaches the machine, and an idle
machine would win their runs before its runner users exist (each such run would fail with a harness error
status) and before step 8 has proven it. Until setup writes `/etc/qorpera-test-machine-versions` the wrapper
counts it as closed anyway; the file keeps it closed through step 8. `guest-setup.sh` comes from a checkout of the
merged change (node 1 has none: copy the one file over and check the digest; a later change to the script changes
the digest). The public key is the one node 2's `tester` has (`~tester/.ssh/authorized_keys` there; the developer
side keeps `~/.ssh/id_ed25519_qorpera_testvm`). Setup prints the versions, the runner users and
`kvm_device=present`.

Network proof, as on node 2 (from inside the VM; every target must be refused, DNS and HTTPS must work):

```sh
lxc exec qorpera-testvm-node01 --project testmachines -- bash -c 'for t in 192.168.1.40:22 192.168.1.40:2049 \
  192.168.1.27:22 192.168.1.42:22 192.168.1.1:80 100.75.4.70:22 100.80.160.64:22 10.201.0.1:22 10.41.0.1:22 \
  10.200.0.1:22 10.203.0.1:22 93.164.62.162:443; do timeout 5 bash -c "</dev/tcp/${t%:*}/${t#*:}" 2>/dev/null \
  && echo "OPEN $t" || echo "refused $t"; done; getent hosts registry.npmjs.org; \
  curl -fsS -o /dev/null -w "https %{http_code}\n" https://registry.npmjs.org/'
timeout 5 bash -c '</dev/tcp/10.201.0.3/22' && echo "node 1 reaches SSH"
```

`93.164.62.162` (our public address) is refused by the guest guard only when node 1's guard enforces; the ACL
does not list it.

### 8. Verify (from a developer checkout with this change)

```sh
node scripts/run-on-node.mjs --dry-run --machine node01 hosted-db </dev/null
node scripts/run-on-node.mjs --machine node01 --no-install -- sh -c 'docker build -q -t qorpera-systemd-test:local - < scripts/fixtures/systemd-test-image.Dockerfile' </dev/null
node scripts/run-on-node.mjs --machine node01 hosted-db </dev/null
node scripts/run-on-node.mjs --machine node01 test </dev/null
```

`--machine` reaches the closed machine. The first connection records node 1's host key under 10.201.0.3. `test`
must pass in full, as on node 2.

### 9. Open

```sh
lxc exec qorpera-testvm-node01 --project testmachines -- rm /etc/qorpera-test-machine-closed
node scripts/run-on-node.mjs --dry-run hosted-db </dev/null
```

The dry run shows both machines open and picks the one with more free slots. From now on plain runs from every
session that has merged this change land on node 1 whenever it has more room (their record's `machine`), and a
run that is still copying to a machine shows there as `arriving` in another session's dry run.

### Undo

- **Out of rotation, nothing changed on the node:** close it (`echo "<reason>" > /etc/qorpera-test-machine-closed`
  as root inside the VM) or stop it (`lxc stop`; probes then skip it). It stays enrolled and charged.
- **Remove it:** close it and wait until `--dry-run --machine node01` shows 0 busy, 0 waiting and 0 arriving. Hold
  (step 2), then `lxc stop qorpera-testvm-node01 --project testmachines` and `lxc delete qorpera-testvm-node01
  --project testmachines`; `lxc project delete testmachines`; `lxc network delete testmach0`; `lxc network acl
  delete testmach-egress`. The VM goes before its entry: an instance the policy does not list makes node 1
  `unavailable`. Then replace node 1's inventory policy with the **current** one minus the
  `testmachines`/`qorpera-testvm-node01` entry (not the step-0 copy: entries enrolled since, such as node 1's fast
  host, and a changed LXD host identity must stay), reviewed as in step 5.3 (`NODE-BUILDER-COEXISTENCE.md` step 8:
  remove only the reviewed reservations). `op --node node01 observer-sync` and wait for `ready`; configure the
  headroom back (-10000 mCPU, -17179869184 bytes, `enabled` false) and wait for a fresh `ready` at the new
  version; then serve (step 6). Dropping `node01` from `MACHINES` is optional (an absent machine is tried last
  and costs a run little).
- **A step fails:** before step 5 commits, delete what step 4 made (VM, project, network, ACL), configure the
  headroom back, wait for a fresh `ready` and serve; here, inside the same hold, the step-0 inventory policy is still
  the current one. From step 5 on, as "Remove it". Setup or proof failing in steps 7-8 needs no undo: the machine
  stays closed until it is fixed. Never re-run an uncertain create or replace: read the
  outcome first.
- **Host keys:** whenever the VM is deleted and made again (a removal, a failed step, a rebuild), every developer
  Mac that reached the old one keeps its host key and sees node 1 as unreachable from then on. Tell sessions to
  run `ssh-keygen -R 10.201.0.3 -f ~/.ssh/known_hosts_qorpera_test_machines`.
