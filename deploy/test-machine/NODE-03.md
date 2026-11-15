# The test machine on node 3

`qorpera-testvm-node03`, `tester@10.201.0.4`, reached through `company41-node-03`. Built 2026-11-15.

## What node 3 is

Node 3 (`company41-node-03`) is a desktop PC in the office: an Intel i7-12700KF (20 threads), 32 GiB of memory and a
1 TB NVMe disk. The owner's decision of 2026-11-15: it is for **testing and internal use only**. It is not a fleet
node. It has no row in `qorpera_runtime_nodes`, no orchestrator, no agent exit and no NAS mount, and it places no
company work. It has the same base as node 2: Ubuntu 26.04.1 on the fleet's pinned kernel, LXD 6.9 rev 40424 (held),
the bridges `coding-net`, `qorpera0` and `testmach0` with node 2's ranges and ACLs, the storage pool `qorpera-vm`, and
the guest guard in enforce.

So this machine is the first in `MACHINES` (`scripts/run-on-node.mjs`): while the machines are equally free, a run
goes to node 3 and stays off the two production nodes.

## How it differs from the other two machines

| | Node 3's machine | The others |
| --- | --- | --- |
| Memory | 20 GiB. The host has 31 GiB usable and keeps the rest for itself and a 4 GiB ZFS ARC | 24 GiB (node 2), 16 GiB (node 1's design) |
| Processor | 10 vCPU on an Intel CPU with fast and slow cores; LXD does not pin them | 10 vCPU on the nodes' AMD CPUs |
| Node accounting | None. Node 3 has no database row, so the VM is not enrolled and nothing is charged | Enrolled as infrastructure; its memory is charged to the node |
| Reach | `company41-node-03` is an SSH name for the node's office-network address. Node 3 is in no tailnet, so a client outside the office does not reach it; its probe gets no answer and the run goes to another machine | Through the tailnet |
| After a node restart | The node's firmware takes about five minutes to start (the board's first BIOS). The VM has `boot.autostart=false`, as the others, so someone starts it | The same, without the slow firmware |

Everything else is the same: image `5e644adaf5d1`, 150 GiB root disk, the NIC filtering, `guest-setup.sh`, the pinned
Codex, the runner users, the key.

## How it was built

[NODE-01.md](NODE-01.md)'s runbook, steps 1, 4, 7, 8 and 9. Steps 2, 3, 5 and 6 (hold, headroom, enroll, serve) are
database steps for an enrolled node and do not apply.

1. The image and the pinned Codex were exported on node 2 and carried over; LXD's fingerprint on node 3 is node 2's.
2. Create, as NODE-01.md step 4, with `limits.memory=20GiB`, `ipv4.address=10.201.0.4` and the name
   `qorpera-testvm-node03`. The project, the bridge and the ACL were already there (node 2's, word for word).
   `G check` printed `bridge testmach0: matches` with the guard in enforce.
3. Start, close (`/etc/qorpera-test-machine-closed`), push the Codex, `guest-setup.sh` (4 minutes).
4. Network proof from inside: the NAS, the three nodes' office addresses, the router, a developer Mac, three tailnet
   addresses, the four bridge gateways and our public address were all refused; DNS and HTTPS worked.
5. Proof runs from a checkout of master: the systemd test image, `hosted-db` (1049 migrations and 587 tests in
   219 s) and `test`. The first `test` had one failure, a real-binary test that could not see the pinned Codex:
   `lxc file push --create-dirs` had left its folder `0750`. `guest-setup.sh` now sets the folder's owner and mode.
   The second `test` passed in full (993 s).

## Undo

Close it (write a reason to `/etc/qorpera-test-machine-closed` as root inside the VM) or stop it. To remove it:
`lxc stop` and `lxc delete qorpera-testvm-node03 --project testmachines` as root on node 3. No database step. Then
drop `node03` from `MACHINES`. A machine that is made again has a new host key: tell sessions to run
`ssh-keygen -R 10.201.0.4 -f ~/.ssh/known_hosts_qorpera_test_machines`.
