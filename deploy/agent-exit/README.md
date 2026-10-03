# Agent exit (E1, E2)

The exit that agent road machines' internet traffic leaves through, one per node, the same on every node. Design and
decisions: `deploy/first-node/RUNTIME-AGENT-EXIT.md` and the contract's "2026-10-03 amendment: agent traffic leaves
through the agent exit". E1 built the exit itself. E2 adds the node's side of the agent plug: the plug tool machine
creators call, its reconciler, `notrack` for the bridged leg, and the health file the node observer reads. It is
installed switched off: no machine kind is plugged in before its own step (E4–E6).

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
| `qorpera-agent-exit.nft` | rules inside `qexit` (`inet qorpera_agent_exit`): our own networks and TCP port 25 refused at once; IPv6, invalid packets and sources outside 10.210.0.0/16 dropped; at most 16,384 open connections per machine and 98,304 in all (decided 3 October; per address until E2's NIC filtering pins each machine to one); plain DNS to any resolver redirected to the exit; new connections and refusals counted per machine (`new_by_client`, `refused_by_client`); refused flows kept an hour for the log (`refused_flows`, `refused_other`), each machine's share rate-limited; masquerade out of `up0`; the exit answers DHCP, and DNS and ping from the agent range, only |
| `qorpera-agent-exit-host.nft` | the node's second line (`inet qorpera_agent_exit_host`): nothing is routed into or out of `qagent0`, and the node does not track what enters from it (`notrack`; the exit tracks and bounds it); `qx-up` reaches public addresses only, never port 25 or the tailnet, and nothing on the node; nothing starts a connection into `qx-up`; the uplink's addresses are refused anywhere else; phase 1's masquerade, to public addresses only |
| `qorpera-agent-exit.sh` | `check`, `up`, `down`, `dns`, `log`, `plug`, `verify`, `health`, `status` |
| `qorpera-agent-exit-log.py` | the connection log: conntrack's start and end of each agent connection (with bytes each way), each refused flow, and a gap line whenever events were lost or a read failed; one JSON line each in `/var/log/qorpera-agent-exit/flows-YYYY-MM-DD.jsonl` (mode 0640); never content. It exits when its reader watches a namespace the exit replaced, and its unit starts it in the new one |
| `qorpera-agent-exit-bridge.nft` | the agents' bridge's own rules (`bridge qorpera_agent_exit_bridge`, on the node): from a machine's port only ARP and IPv4 from a MAC and address pair in the client map, and DHCP requests from a client map MAC; the node takes nothing from the bridge. `up` loads it with its sets filled from the client map, in one transaction |
| `qorpera-agent-plug.py` | the agent plug (below): `plug` for machine creators, `reconcile` for the plug unit, `elements`, `list` |
| `qorpera-agent-exit.service` | oneshot, ordered before LXD: `up` (it turns on IPv4 forwarding if LXD has not yet), then starts the name and log units; reload repairs in place; stop is `down`, which with a machine plugged in fails and changes nothing |
| `qorpera-agent-exit-dns.service` | dnsmasq, run inside `qexit` (`NetworkNamespacePath=`) and sandboxed: static DHCP leases (10 minutes) from `/var/lib/qorpera-agent-exit/dhcp-hosts` (E2 writes one `mac,address` file per machine, readable by dnsmasq's unprivileged user, and reloads the unit after removing one), machines' own names ignored and never published, DNS forwarded to 9.9.9.9 and 1.1.1.1, every query logged to `/var/log/qorpera-agent-exit/dns.log` |
| `qorpera-agent-exit-log.service` | the connection log |
| `qorpera-agent-plug.service` | the agent plug's reconciler, as root, after LXD |
| `qorpera-agent-exit-health.service`, `.timer` | `health` every 10 seconds: `verify`'s answer as `/run/qorpera-agent-exit/health.json` (`{schema, healthy, checkedAt, problems}`, mode 0644) for the node observer, which has no capabilities and cannot run `verify` |
| `install-agent-exit.sh` | verifies the pins, copies the files, runs `check`; installs no package, creates no group, starts and enables nothing |

Packages: `dnsmasq-base` and `conntrack` (neither starts a service of its own), and `python3`.

## The agent plug (E2)

A machine creator (a member of the group `qorpera-agent-plug`) calls, before it creates a machine:

```
/usr/local/libexec/qorpera-agent-exit/qorpera-agent-plug.py plug --kind machine|coding|office \
	--company <company id> --machine <machine or office id> [--member <member id, coding only>] \
	--project <LXD project> --instance <LXD instance>
```

It prints `{"address": "10.210.x.y", "hwaddr": "0e:51:0a:d2:xx:yy"}`: the lowest free address outside
`10.210.0.0/24` (kept for the exit's own services) that is not in quarantine and not still held by a machine, and a
MAC made from it. It writes the client map entry `/var/lib/qorpera-agent-exit/clients/<address>.json`
(created exclusively, so two creators never share an address) and the lease `dhcp-hosts/<address>`, which dnsmasq
reads by itself. Asked again for the same instance, it gives the same answer (with a new time when the machine it was given to has
been seen: it is being made again); for another machine on the same instance it refuses. Files get mode 0644
whatever the creator's umask (dnsmasq's unprivileged user reads the leases). The creator then makes the machine with this card, and nothing else on `qagent0`:

```
type: nic, nictype: bridged, parent: qagent0, name: <eth0 | eth1>, hwaddr: <hwaddr>, ipv4.address: <address>,
ipv6.address: none, security.mac_filtering: true, security.ipv6_filtering: true, security.port_isolation: true
```

Not `security.ipv4_filtering`: LXD's IPv4 filter has no DHCP exception in its forward chain, so on a bridge it does
not manage it drops every DHCP request on its way to the exit. `qorpera-agent-exit-bridge.nft` ties each MAC to its
address instead (below).

and its usual identity keys: `user.qorpera.company_id`, `user.qorpera.machine_id` (an agents' or coding machine) or
`user.qorpera.office_id` (a Company Computer), and `user.qorpera.member_user_id` (a coding machine).

Everything after that is the reconciler's (`qorpera-agent-plug.service`, root), which reads LXD every 5 seconds:
- a machine that stops (asleep) keeps its address and entry; its connections are flushed once;
- a machine that is gone (missing from two reads of LXD in a row after it was seen, or never created within an hour
  of its plug) is unplugged under the plug lock: quarantined for 15 minutes first, then it loses its lease (dnsmasq
  reloads), its connections, the exit's per-machine counts and refused flows, and its entry. A failed flush is
  tried again every pass; the address is not given out before it succeeds. An entry removed by hand is unplugged
  the same way, from the reconciler's own copy;
- a flush ends the address's connections in the exit's table and their masqueraded twins in the node's (TCP, UDP and
  ICMP; other protocols' twins end with their timeout);
- every entry is checked against its machine (the card above, the identity keys), a running machine's card must be
  a port of `qagent0`, and every machine on `qagent0` must have an entry. A problem goes to
  `/run/qorpera-agent-exit/plug.json`, and `verify` fails while there is one;
- it keeps the bridge rules' sets (`clients`: MAC and address pairs; `client_macs`) equal to the client map;
- `/var/log/qorpera-agent-exit/clients-YYYY-MM-DD.jsonl` (mode 0640) ties an address to a company only for an entry
  LXD backs: `plugged` (from the entry's time) once it matches, `unplugged` when it goes. An entry LXD does not back
  gets a `mismatch` line (the claim, what LXD says, the problems) and is never attributed; one that goes without
  ever matching is `dropped`; a machine on `qagent0` without an entry is `unattributed`. So a forged entry cannot
  put another company's name on traffic, and E3's lookup ties an address to its company as long as the flow log is
  kept.

The creators make no other call. Never remove a client map entry or lease by hand: the reconciler does, in the right
order. `clients/` and `dhcp-hosts/` are root's, group `qorpera-agent-plug`, mode 3775 (setgid, so files keep the
group; sticky, so a creator cannot remove another's).

## Switching a node on (coordinator, root, after E2 is merged)

`X` below is `/usr/local/libexec/qorpera-agent-exit/qorpera-agent-exit.sh`.

1. `apt-get install --no-install-recommends dnsmasq-base conntrack python3`
2. `groupadd --system qorpera-agent-plug` (before the first `up`, which gives the client map directories to it).
3. `bash deploy/agent-exit/install-agent-exit.sh` from a checkout at the merged head.
4. `systemctl enable --now qorpera-agent-exit.service qorpera-agent-exit-dns.service qorpera-agent-exit-log.service
   qorpera-agent-plug.service qorpera-agent-exit-health.timer`
5. `X verify` says `healthy`; `X status` shows the addresses and an empty client map;
   `/run/qorpera-agent-exit/health.json` says `"healthy": true`.
6. Undo, only with an empty client map (`X status`):
   `systemctl disable --now qorpera-agent-exit-health.timer qorpera-agent-exit.service`, then
   `systemctl disable qorpera-agent-exit-dns.service qorpera-agent-exit-log.service qorpera-agent-plug.service`.
   The exit's stop stops the name, log and plug units itself. Never stop those by name while a machine is plugged in:
   traffic would keep flowing without names and without the log, and nothing would flush or unplug machines.

A machine kind is plugged in only by its own step (E4–E6): its creator's unit joins the group
(`SupplementaryGroups=qorpera-agent-plug`), may write `clients/` and `dhcp-hosts/` under
`/var/lib/qorpera-agent-exit`, and reads the rest of it (`plug.lock`, `quarantine/`, `seen/`).

With a machine plugged in (in the client map, running or asleep), a stop of the exit's unit fails and changes nothing:
the exit and its name, log and plug services keep running (they are not bound to the exit's unit), `X verify` stays
healthy, and the unit is marked failed until `systemctl start qorpera-agent-exit.service` (in place) clears it. There
is no override; a machine leaves the exit when it is deleted.

ufw is installed on the nodes but switched off (`ENABLED=no`). If it is ever switched on, its default forward policy
(DROP) would refuse the bridged traffic between agent road machines and the exit, and LXD's guests' traffic too.

The guest guard (`deploy/guest-guard/`) must never list `qagent0`: with br_netfilter, traffic between an agent road machine
and the exit is bridged and would be refused as a private destination.

## Health and failure

`X verify` exits 0 only when the namespace, the bridge (not forwarding, a reverse-path filter on, not answering ARP),
both addresses, the default route, both rule tables, DNS on 10.210.0.1:53 (from a name service in the exit's current
namespace), a logger heartbeat younger than 30 seconds and a reconciler status younger than 30 seconds with no
problem are all there. The heartbeat is written only while both of the logger's readers are alive. If the exit is
down, its agent road machines have no internet; nothing falls back to the platform road. `X health` (every 10
seconds) writes the answer for the node observer; E2d keeps new agent road machines off a node whose exit is not
healthy.

`up` restarts the name service when it runs in an older namespace than the exit's (after a rebuild, also one an
earlier, interrupted `up` made); the logger notices the same by itself and exits.

## Test

`qorpera-agent-exit.test.mjs` checks the pins, the logger's parsers and the plug tool: allocation under the
creators' umask, twelve plugs at once, quarantine, and the reconciler against a stand-in for LXD (attribution only
after a match, a forged claim, sleep, two misses before an unplug, a machine made again, an entry removed by hand,
plugs never created, unusable entries and links never followed, the bridge sets, the twins it finds). On Linux with
Docker it runs `test/proof.sh` in a privileged container with no network of its own (`ubuntu:26.04` with the
packages above, built once and cached). The proof never leaves the container's namespaces and never unloads a
kernel module (the kernel loads nftables' own on demand).
The proof plays a node: an agent road machine plugged into `qagent0` by a creator (a member of the plug group, umask
077), the office network (router, NAS, node 1), a small internet (a site, a resolver, our public address) and node 1
on the tailnet. It checks:
- DHCP, names, the DNS redirect and the query log;
- that a site sees the node's own address;
- that mail servers, the NAS, the router, both nodes, the uplink, Tailscale and our public address are refused at
  once, that the exit answers nothing else, and that its own uplink reaches neither the office network nor the node;
- the bridge rules: a source that is not the machine's own address (in the agent range or outside it) dropped and
  counted, DNS from a forged source ignored, and a card outside the client map without an address or internet;
- the per-client counts;
- a refusal of another protocol (253) next to a TCP one, which the logger survives;
- that the node routes nothing from the agents' bridge (the bridge's own MAC as next hop towards the NAS) and does
  not answer ARP there;
- the log's records (bytes each way, refused flows of any protocol, agent connections only);
- the agent plug with the reconciler running: lowest free addresses, twenty plugs at once, DHCP for a plugged
  machine, problems for a wrong identity, a machine without an entry and a card off the bridge (and `health` saying
  so), a forged entry (unhealthy, a mismatch line, dropped and never attributed), a sleep that ends the machine's
  TCP, UDP and ICMP connections in the exit and their twins on the node, a removal (quarantine, no more DHCP, the
  address skipped), and plugs never created given up;
- an interrupted rebuild: the logger leaves the old namespace by itself, and `verify` fails until DNS follows;
- that `down` refuses with a machine plugged in, or only in the client map, and changes nothing; that with the
  exit's namespace gone the machine has no internet and no names; and that with nothing plugged in `down` removes
  everything while the name and log services run.

Where the kernel has br_netfilter loaded, the proof also checks that the node does not track the bridged leg; the
test machines do not load it, so it prints a SKIP line there. Not covered here: br_netfilter, LXD's own MAC and IPv6
filters and port isolation, LXD's API as the reconciler reads it, systemd's handling of the units, and running
beside the guest guard, LXD and Tailscale on a real node. E2b's proof, in a throwaway VM with its own LXD inside a
test machine, covers the first three.

`run-on-node.mjs changed` runs it on the node 2 test machine.

## Notes for later steps

- E3 (log shipping): rotate `dns.log` by copying and truncating it, not by renaming it and sending SIGUSR2. dnsmasq's
  unprivileged user cannot create a file in the 0750 log directory, so a reopen would fail and logging would stop.
- E2b: the per-machine connection bound counts per address; the bridge rules and LXD's MAC filter pin each machine
  to its address. A reload of the rules starts both counts again from zero. The total is one shared list in the
  kernel: E2b measures its cost under load, and the tables under floods (TCP open and close, UDP, other protocols,
  spoofed sources, IPv6) with `notrack` on, before any node is switched on. The node's table holds 262,144 entries
  (read on both nodes, 2 October); with `notrack` it holds only the masqueraded leg of each agent connection. E2b
  runs in a throwaway VM inside a test machine, never bare on it: loading or unloading kernel modules there changes
  the whole test machine (`modprobe -r br_netfilter` also unloads `bridge`, which destroys every bridge on it).
- E2c, E4–E6: the creators call `plug` before they create a machine; their units join the group and get write access
  to `clients/`, `dhcp-hosts/` and `plug.lock`. The node inventory pins a machine's devices when it first sees it,
  so the plug is never added to a machine that exists.
- The refused-flow log: a flow is logged when it is first refused and again each time it is added back after its hour
  runs out. Refusals the exit could not keep (a machine's share spent, or a set full) are counted in
  `refused_unlogged`, and the logger writes a gap line for them.
