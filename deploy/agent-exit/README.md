# Agent exit (E1)

The exit that agent road machines' internet traffic leaves through, one per node, the same on every node. Design and
decisions: `deploy/first-node/RUNTIME-AGENT-EXIT.md` and the contract's "2026-10-03 amendment: agent traffic leaves
through the agent exit". This step builds the exit itself. It is installed switched off: nothing is plugged into it
until step E2 (the agent plug), and no machine kind moves to it before its own step (E4–E6).

## Layout

| Part | Where | Address |
| --- | --- | --- |
| Namespace `qexit` | the exit | |
| Bridge `qagent0` | the node, with no address, so agent road machines never reach a node service | |
| veth `qx-br` / `br0` | `qx-br` is a port of `qagent0`; `br0` is in `qexit` | `br0` 10.210.0.1/16: the agents' gateway, DHCP and DNS |
| veth `qx-up` / `up0` | the uplink | `qx-up` 10.209.255.1/30 on the node, `up0` 10.209.255.2/30 in `qexit` |

Agent road machines get addresses from 10.210.0.0/16, the same range on every node; a machine only ever uses the exit of
the node it runs on.

Phase 1 (until TDC delivers the address block): the exit masquerades to 10.209.255.2, and the node masquerades that
out of its own uplink, so agent traffic leaves from 93.164.62.162. Phase 2 (E9) gives `up0` a public address of its
own and removes the node's masquerade.

## Files

| File | What |
| --- | --- |
| `qorpera-agent-exit.nft` | rules inside `qexit` (`inet qorpera_agent_exit`): our own networks and TCP port 25 refused at once; IPv6, invalid packets and sources outside 10.210.0.0/16 dropped; at most 16,384 open connections per machine and 98,304 in all (proposed, pending Jonas; per address until E2's NIC filtering pins each machine to one); plain DNS to any resolver redirected to the exit; new connections and refusals counted per machine (`new_by_client`, `refused_by_client`); refused flows kept an hour for the log (`refused_flows`, `refused_other`), each machine's share rate-limited; masquerade out of `up0`; the exit answers DHCP, and DNS and ping from the agent range, only |
| `qorpera-agent-exit-host.nft` | the node's second line (`inet qorpera_agent_exit_host`): nothing is routed into or out of `qagent0`; `qx-up` reaches public addresses only, never port 25 or the tailnet, and nothing on the node; nothing starts a connection into `qx-up`; the uplink's addresses are refused anywhere else; phase 1's masquerade, to public addresses only |
| `qorpera-agent-exit.sh` | `check`, `up`, `down`, `dns`, `log`, `verify`, `status` |
| `qorpera-agent-exit-log.py` | the connection log: conntrack's start and end of each agent connection (with bytes each way), each refused flow, and a gap line whenever events were lost or a read failed; one JSON line each in `/var/log/qorpera-agent-exit/flows-YYYY-MM-DD.jsonl` (mode 0640); never content |
| `qorpera-agent-exit.service` | oneshot, ordered before LXD: `up` (it turns on IPv4 forwarding if LXD has not yet), then starts the name and log units; reload repairs in place; stop is `down`, which with a machine plugged in fails and changes nothing |
| `qorpera-agent-exit-dns.service` | dnsmasq, run inside `qexit` (`NetworkNamespacePath=`) and sandboxed: static DHCP leases (10 minutes) from `/var/lib/qorpera-agent-exit/dhcp-hosts` (E2 writes one `mac,address` file per machine, readable by dnsmasq's unprivileged user, and reloads the unit after removing one), machines' own names ignored and never published, DNS forwarded to 9.9.9.9 and 1.1.1.1, every query logged to `/var/log/qorpera-agent-exit/dns.log` |
| `qorpera-agent-exit-log.service` | the connection log |
| `install-agent-exit.sh` | verifies the pins, copies the files, runs `check`; installs no package, starts and enables nothing |

Packages: `dnsmasq-base` and `conntrack` (neither starts a service of its own), and `python3`.

## Switching a node on (coordinator, root, after E2 is merged)

`X` below is `/usr/local/libexec/qorpera-agent-exit/qorpera-agent-exit.sh`.

1. `apt-get install --no-install-recommends dnsmasq-base conntrack python3`
2. `bash deploy/agent-exit/install-agent-exit.sh` from a checkout at the merged head.
3. `systemctl enable --now qorpera-agent-exit.service qorpera-agent-exit-dns.service qorpera-agent-exit-log.service`
4. `X verify` says `healthy`; `X status` shows the addresses and an empty plugged-in list.
5. Undo, only with no machine plugged in (`X status` shows an empty plugged-in list):
   `systemctl disable --now qorpera-agent-exit.service`, then
   `systemctl disable qorpera-agent-exit-dns.service qorpera-agent-exit-log.service`.
   The exit's stop stops the name and log units itself. Never stop those two by name while a machine is plugged in:
   traffic would keep flowing without names and without the log.

With a machine plugged in, a stop of the exit's unit fails and changes nothing: the exit, its name service and its log
keep running (they are not bound to the exit's unit), `X verify` stays healthy, and the unit is marked failed until
`systemctl start qorpera-agent-exit.service` (in place) clears it. There is no override; a machine leaves the exit
when it stops or moves.

ufw is installed on the nodes but switched off (`ENABLED=no`). If it is ever switched on, its default forward policy
(DROP) would refuse the bridged traffic between agent road machines and the exit, and LXD's guests' traffic too.

The guest guard (`deploy/guest-guard/`) must never list `qagent0`: with br_netfilter, traffic between an agent road machine
and the exit is bridged and would be refused as a private destination.

## Health and failure

`X verify` exits 0 only when the namespace, the bridge (not forwarding, strict reverse-path filter, not answering ARP),
both addresses, the default route, both rule tables, DNS on 10.210.0.1:53 and a logger heartbeat younger than 30
seconds are all there. The heartbeat is written only while both of the logger's readers are alive. If the exit is
down, its agent road machines have no internet; nothing falls back to the platform road. E2 makes the node observer report `verify` and keeps new
agent road machines off a node whose exit is not healthy.

## Test

`qorpera-agent-exit.test.mjs` checks the pins and the logger's parsers, and on Linux with Docker runs `test/proof.sh`
in a privileged container with no network of its own (`ubuntu:26.04` with the packages above, built once and cached).
The proof plays a node: an agent road machine plugged into `qagent0` with a static lease, the office network (router,
NAS, node 1), a small internet (a site, a resolver, our public address) and node 1 on the tailnet. It checks:
- DHCP, names, the DNS redirect and the query log;
- that a site sees the node's own address;
- that mail servers, the NAS, the router, both nodes, the uplink, Tailscale and our public address are refused at
  once, that the exit answers nothing else, and that its own uplink reaches neither the office network nor the node;
- the spoofed-source drop, DNS from a forged source ignored, and the per-client counts;
- a refusal of another protocol (253) next to a TCP one, which the logger survives;
- that the node routes nothing from the agents' bridge (the bridge's own MAC as next hop towards the NAS) and does
  not answer ARP there;
- the log's records (bytes each way, refused flows of any protocol, agent connections only);
- that `down` refuses with a machine plugged in and changes nothing; that with the exit's namespace gone the machine
  has no internet and no names; and that with nothing plugged in `down` removes everything while the name and log
  services run.

Not covered here: br_netfilter (the test machine does not load it), LXD's own NIC filtering, and running beside the
guest guard, LXD and Tailscale on a real node. Those come with E2's switch-on proof on a node.

`run-on-node.mjs changed` runs it on the node 2 test machine.

## Notes for later steps

- E3 (log shipping): rotate `dns.log` by copying and truncating it, not by renaming it and sending SIGUSR2. dnsmasq's
  unprivileged user cannot create a file in the 0750 log directory, so a reopen would fail and logging would stop.
- E2: the per-machine connection bound counts per address; E2's NIC filtering pins each machine to its address. A
  reload of the rules starts both counts again from zero. The total is one shared list in the kernel: E2's switch-on
  proof on a node measures its cost under load before Jonas decides the numbers.
- E2: with br_netfilter the node itself tracks the bridged leg of every agent packet, refused ones included (a few
  seconds each). E2 proves the node's own connection table keeps room under a flood of refused connections, or
  stops the node tracking bridged `qagent0` traffic.
- The refused-flow log: a flow is logged when it is first refused and again each time it is added back after its hour
  runs out. Refusals the exit could not keep (a machine's share spent, or a set full) are counted in
  `refused_unlogged`, and the logger writes a gap line for them.
