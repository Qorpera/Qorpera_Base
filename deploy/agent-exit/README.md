# Agent exit (E1)

The exit that agent machines' internet traffic leaves through, one per node, the same on every node. Design and
decisions: `deploy/first-node/RUNTIME-AGENT-EXIT.md` and the contract's "2026-10-03 amendment: agent traffic leaves
through the agent exit". This step builds the exit itself. It is installed switched off: nothing is plugged into it
until step E2 (the agent plug), and no machine kind moves to it before its own step (E4–E6).

## Layout

| Part | Where | Address |
| --- | --- | --- |
| Namespace `qexit` | the exit | |
| Bridge `qagent0` | the node, with no address, so agent machines never reach a node service | |
| veth `qx-br` / `br0` | `qx-br` is a port of `qagent0`; `br0` is in `qexit` | `br0` 10.210.0.1/16: the agents' gateway, DHCP and DNS |
| veth `qx-up` / `up0` | the uplink | `qx-up` 10.209.255.1/30 on the node, `up0` 10.209.255.2/30 in `qexit` |

Agent machines get addresses from 10.210.0.0/16, the same range on every node; a machine only ever uses the exit of
the node it runs on.

Phase 1 (until TDC delivers the address block): the exit masquerades to 10.209.255.2, and the node masquerades that
out of its own uplink, so agent traffic leaves from 93.164.62.162. Phase 2 (E9) gives `up0` a public address of its
own and removes the node's masquerade.

## Files

| File | What |
| --- | --- |
| `qorpera-agent-exit.nft` | rules inside `qexit` (`inet qorpera_agent_exit`): our own networks and TCP 25 refused at once, IPv6 dropped, a source outside 10.210.0.0/16 dropped, plain DNS to any resolver redirected to the exit, new connections counted per client (`new_by_client`), refused flows kept an hour for the log (`refused_flows`), masquerade out of `up0`; the exit itself answers DHCP, DNS and ping only |
| `qorpera-agent-exit-host.nft` | the node's second line (`inet qorpera_agent_exit_host`): `qx-up` may reach public addresses only and nothing on the node; nothing starts a connection into `qx-up`; phase 1's masquerade |
| `qorpera-agent-exit.sh` | `check`, `up`, `down`, `dns`, `log`, `verify`, `status` |
| `qorpera-agent-exit-log.py` | the connection log: conntrack's start and end of each agent connection (with bytes each way) and each refused flow, one JSON line each, in `/var/log/qorpera-agent-exit/flows-YYYY-MM-DD.jsonl`; never content |
| `qorpera-agent-exit.service` | oneshot: `up`; reload repairs; stop is `down` (refused while a machine is plugged in) |
| `qorpera-agent-exit-dns.service` | dnsmasq in `qexit`: static DHCP leases from `/var/lib/qorpera-agent-exit/dhcp-hosts` (E2 writes one `mac,address,name` file per machine), DNS forwarded to 9.9.9.9 and 1.1.1.1, every query logged to the journal |
| `qorpera-agent-exit-log.service` | the connection log |
| `install-agent-exit.sh` | verifies the pins, copies the files, runs `check`; installs no package, starts and enables nothing |

Packages: `dnsmasq-base` and `conntrack` (neither starts a service of its own), and `python3`.

## Switching a node on (coordinator, root, after E2 is merged)

`X` below is `/usr/local/libexec/qorpera-agent-exit/qorpera-agent-exit.sh`.

1. `apt-get install --no-install-recommends dnsmasq-base conntrack`
2. `bash deploy/agent-exit/install-agent-exit.sh` from a checkout at the merged head.
3. `systemctl enable --now qorpera-agent-exit.service` (the DNS and log units start with it).
4. `X verify` says `healthy`; `X status` shows the addresses and an empty plugged-in list.
5. Undo: `systemctl disable --now qorpera-agent-exit.service` (refused while a machine is plugged in: empty the node
   first, or `X down --force`).

The guest guard (`deploy/guest-guard/`) must never list `qagent0`: with br_netfilter, traffic between an agent machine
and the exit is bridged and would be refused as a private destination.

## Health and failure

`X verify` exits 0 only when the namespace, the bridge, both addresses, the default route, both rule tables, DNS on
10.210.0.1:53 and a logger heartbeat younger than 60 seconds are all there. If the exit is down, its agent machines
have no internet; nothing falls back to the platform road. E2 makes the node observer report `verify` and keeps new
agent machines off a node whose exit is not healthy.

## Test

`qorpera-agent-exit.test.mjs` checks the pins and the logger's parsers, and on Linux with Docker runs `test/proof.sh`
in a privileged container with no network of its own (`ubuntu:26.04` with the packages above, built once and cached).
The proof plays a node: an agent machine plugged into `qagent0` with a static lease, the office network (router,
NAS, node 1), a small internet (a site, a resolver, our public address) and node 1 on the tailnet. It checks:
- DHCP, names, the DNS redirect and the query log;
- that a site sees the node's own address;
- that mail servers, the NAS, the router, both nodes, the uplink, Tailscale and our public address are refused at
  once, that the exit answers nothing else, and that its own uplink reaches neither the office network nor the node;
- the spoofed-source drop and the per-client counts;
- the log's records (bytes each way, refused flows, agent connections only);
- that `down` refuses with a machine plugged in, and that with the exit down the machine has no internet and nothing
  is left behind.

`run-on-node.mjs changed` runs it on the node 2 test machine.
