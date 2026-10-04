# Agent exit (E1, E2)

The exit that agent road machines' internet traffic leaves through, one per node, the same on every node. Design and
decisions: `deploy/first-node/RUNTIME-AGENT-EXIT.md` and the contract's "2026-10-03 amendment: agent traffic leaves
through the agent exit". E1 built the exit itself. E2 adds the node's side of the agent plug: the plug tool machine
creators call, its reconciler, the bridge rules that tie each port to its MAC and each MAC to its address, `notrack`
for the bridged leg, and the health file the node observer reads. Nothing is plugged in until the creators call `plug`
(E2c); with no users and no legacy machines (founder decision, 3 October) there are no switches and nothing to
migrate. Nothing is installed in production before a milestone release.

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
| `qorpera-agent-exit.nft` | rules inside `qexit` (`inet qorpera_agent_exit`): our own networks and TCP port 25 refused at once; IPv6, invalid packets and sources outside 10.210.0.0/16 dropped; at most 16,384 open connections per machine and 98,304 in all (decided 3 October; per address, and the bridge rules pin each machine to one); a closed agent TCP connection held 30 s, not 120 (`ct timeout agent_tcp`); plain DNS to any resolver redirected to the exit; new connections and refusals counted per machine (`new_by_client`, `refused_by_client`); refused flows kept an hour for the log (`refused_flows`, `refused_other`), each machine's share rate-limited; masquerade out of `up0`; the exit answers DHCP, and DNS and ping from the agent range, only |
| `qorpera-agent-exit-host.nft` | the node's second line (`inet qorpera_agent_exit_host`): nothing is routed into or out of `qagent0`, and the node does not track what enters from it (`notrack`; the exit tracks and bounds it); the masqueraded leg of a closed agent TCP connection is held 30 s, not 120; `qx-up` reaches public addresses only, never port 25 or the tailnet, and nothing on the node; nothing starts a connection into `qx-up`; the uplink's addresses are refused anywhere else; phase 1's masquerade, to public addresses only |
| `qorpera-agent-exit.sh` | `check`, `up`, `down`, `dns`, `log`, `plug`, `verify`, `health`, `status` |
| `qorpera-agent-exit-log.py` | the connection log: conntrack's start and end of each agent connection (with bytes each way), each refused flow, and a gap line whenever events were lost or a read failed; one JSON line each in `/var/log/qorpera-agent-exit/flows-YYYY-MM-DD.jsonl` (mode 0640); never content. It exits when its reader watches a namespace the exit replaced, and its unit starts it in the new one |
| `qorpera-agent-exit-bridge.nft` | the agents' bridge's own rules (`bridge qorpera_agent_exit_bridge`, on the node): before the bridge learns a MAC, a machine's port sends only its own MAC (`ports`, from LXD), so no machine takes another's or the exit's; then only ARP (its sender fields too) and IPv4 from a MAC and address pair in the client map, and DHCP only through one rule per machine (its own MAC, from no address or its own, naming its own MAC as the client), so no machine can take, release or decline another's lease; the node takes nothing from the bridge. `up` loads it filled with the entries LXD backed and the ports it held, in one transaction; the reconciler keeps it equal to LXD |
| `qorpera-agent-plug.py` | the agent plug (below): `plug` for machine creators, `reconcile` for the plug unit, `elements`, `list` |
| `qorpera-agent-exit.service` | oneshot, ordered before LXD: `up` (it turns on IPv4 forwarding if LXD has not yet), then starts the name, log and plug units; reload repairs in place; stop is `down`, which with a machine plugged in fails and changes nothing |
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

It prints `{"address": "10.210.x.y", "hwaddr": "0e:51:0a:d2:xx:yy"}`: the lowest free address outside `10.210.0.0/24`
(kept for the exit's own services) that is not in quarantine and not still held by a machine, and a MAC made from it.
It writes the client map entry `/var/lib/qorpera-agent-exit/clients/<address>.json` (created exclusively, so two
creators never share an address) and the lease `dhcp-hosts/<address>`, which dnsmasq reads by itself. Asked again for
the same instance, it gives the same answer (with a new time when the machine it was given to has been seen: it is
being made again); for another machine on the same instance it refuses. Files get mode 0644 whatever the creator's
umask (dnsmasq's unprivileged user reads the leases). The creator then makes the machine with this card, and nothing
else on `qagent0`:

```
type: nic, nictype: bridged, parent: qagent0, name: <eth0 | eth1>, hwaddr: <hwaddr>, ipv6.address: none,
security.mac_filtering: true, security.ipv6_filtering: true, security.port_isolation: true
```

No `ipv4.address`: LXD 6.9 refuses it on a bridge it does not manage unless its own IPv4 filter is on ("Cannot use
manually specified ipv4.address when using unmanaged parent bridge", seen in E2b's proof). The machine's address lives
in the client map, its lease and the bridge rules, all tied to the MAC on the card.

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
- it keeps the bridge rules (the `ports` set of each running machine's port and MAC, the `clients` set of MAC and
  address pairs, and the `dhcp` chain's rule per machine) equal to the entries LXD backs, read back every pass, so a
  restart or a crash (and the plain hand edits) are set right within a pass. Until a machine is in them, nothing from
  its card passes: a new machine, or one that just woke, may wait one pass for its first DHCP answer. An entry LXD does
  not back gets no traffic at all;
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

Each creator's unit (E2c) joins the group (`SupplementaryGroups=qorpera-agent-plug`), may write `clients/` and
`dhcp-hosts/` under `/var/lib/qorpera-agent-exit`, and reads the rest of it (`plug.lock`, `quarantine/`, `seen/`).
There are no switches: with no users and no legacy machines (founder decision, 3 October), every machine of the new
architecture is made with its plug.

With a machine plugged in (in the client map, running or asleep), a stop of the exit's unit fails and changes nothing:
the exit and its name, log and plug services keep running (they are not bound to the exit's unit), `X verify` stays
healthy, and the unit is marked failed until `systemctl start qorpera-agent-exit.service` (in place) clears it. There
is no override; a machine leaves the exit when it is deleted.

ufw is installed on the nodes but switched off (`ENABLED=no`). If it is ever switched on, its default forward policy
(DROP) would refuse the bridged traffic between agent road machines and the exit, and LXD's guests' traffic too.

The guest guard (`deploy/guest-guard/`) must never list `qagent0`: with br_netfilter, traffic between an agent road
machine and the exit is bridged and would be refused as a private destination.

## Health and failure

`X verify` exits 0 only when the namespace, the bridge (not forwarding, a reverse-path filter on, not answering ARP),
both addresses, the default route, the three rule tables, LLDP forwarded through the bridge rules, DNS on
10.210.0.1:53 (from a name service in the exit's current namespace), a logger heartbeat younger than 30 seconds and a
reconciler status younger than 30 seconds with no problem are all there. The heartbeat is written only while both of
the logger's readers are alive. If the exit is down, its agent road machines have no internet; nothing falls back to
the platform road. `X health` (every 10 seconds) writes the answer for the node observer; E2d keeps new agent road
machines off a node whose exit is not healthy.

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
- the bridge rules on their own (a static gateway neighbour takes ARP out of it): another address and another MAC
  seen nowhere in the exit, gratuitous ARP for another machine's address, an ARP sender MAC, a DHCPDECLINE naming
  another machine's MAC, another machine's MAC and the exit's taken by a machine (`bridge fdb`), an LLDP-addressed
  frame (nothing on the node, no MAC learnt), and a frame from the exit to a forgotten MAC (no other machine sees it);
- the agent plug with the reconciler running: lowest free addresses, twenty plugs at once, nothing for a plugged card
  until LXD backs it, then DHCP for it, problems for a wrong identity, a machine without an entry and a card off the
  bridge (and `health` saying so), a forged entry (unhealthy, a mismatch line, dropped and never attributed), a sleep
  that ends the machine's TCP, UDP and ICMP connections in the exit and their twins on the node, a removal
  (quarantine, no more DHCP, the address skipped), and plugs never created given up;
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

## E2b: the proof on real LXD

`test/prove-lxd-vm.sh` runs as root on a test machine, never on a node:

```
node scripts/run-on-node.mjs --machine node01 --sudo --no-install --no-status -- bash deploy/agent-exit/test/prove-lxd-vm.sh </dev/null
```

It changes nothing of the test machine's own network. It claims an LXD project, makes a throwaway VM with no
network card in it, pushes in LXD 6.9 rev 40424 (the nodes' revision), a container image and two packages (the VM is
offline), and runs `test/prove-lxd.sh` inside. That VM has its own kernel and LXD: it loads br_netfilter, builds the
exit and plugs real LXD containers in the creators' way. Afterwards the test machine's links (but Docker's), nft
tables, a few sysctls and the network modules a proof could load are compared with before; a difference fails the
run. (LXD loads `vhost_vsock` for any VM; it is not one of the watched modules.)

Result, 4 October, run 20261004T010449-27534-09ca610c on node 1's test machine (LXD 6.9 rev 40424 as on the nodes;
the VM's kernel 7.0.0-34, the nodes' 7.0.0-30), all passed:

| Check | Result |
| --- | --- |
| Plug | two containers plugged in the creators' way get their addresses by DHCP from the exit; the card carries only the MAC (LXD refuses `ipv4.address` on an unmanaged parent without its IPv4 filter) |
| Reach | the stand-in internet through the exit; our networks refused; the node holds no bridged leg (`notrack`) |
| LXD's own layers | each machine's port isolated; with the exit's rules opened for it, LXD's MAC filter alone stops SYNs sent from another MAC (counted leaving the machine; the exit, which counts the same SYNs from the machine's own MAC, counts none of them) and LXD's IPv6 filter alone stops IPv6 (counted leaving, never forwarded) |
| Spoofing | another address and another machine's address towards the internet (the exit forwards and counts nothing from them), another MAC, any IPv6, gratuitous ARP for another machine, a spoofed ARP sender MAC, a DHCPDECLINE from port 68 naming another machine's MAC (seen reaching the bridge, never dnsmasq), another machine's MAC or the exit's taken (`bridge fdb`): none gets through |
| Flooding | a frame from the exit to a MAC the bridge has forgotten reaches no other machine |
| Default deny | a new machine gets nothing until the reconciler has it in the rules; with the reconciler down and the pairs flushed nothing passes, and restarted it sets them right within a pass; an `up` reload keeps running machines' traffic by itself |
| Lifecycle | a sleeping machine loses its connections in both tables and wakes with its address; a deleted one goes into quarantine; a stray card makes the exit unhealthy until it is gone |

Floods from one machine, 20,000 each (each phase capped at 60 s), with `notrack` and without it:

| Flood | Time | Exit's table | Node's table | Over the machine's bound |
| --- | --- | --- | --- | --- |
| TCP open and close to a site | 13 s | +19,793 | +19,782 (+39,711 without `notrack`) | 0 |
| SYNs nobody answers | 13 s | +11,313 | +11,306 | 0 |
| SYNs the exit refuses | 0.6 s | 0 | 0 | 0 |
| UDP to 20,000 ports | 19 s | +16,392 | +16,388 (+36,386 without) | 3,616 refused |
| another protocol (253) | 0.3 s | +251 | +250 | 0 |
| spoofed sources | 0.1 s | 0 | −250 (earlier entries expiring meanwhile; none added) | 0 |
| IPv6 | 0.3 s | +2 (the exit's own lookups meanwhile; no IPv6 reaches it) | 0 | 0 |

What the numbers say:
- Refused, spoofed and IPv6 floods leave nothing in either table; the per-machine bound holds (UDP stopped at 16,384).
- `notrack` halves what a machine leaves in the node's table.
- The shared total's cost could not be told apart from load: 5,000 new connections took 9.7 s and then 11.9 s, 10.1 s
  and then 7.7 s, and 8.8 s and then 13.9 s in three runs, the second each time while another machine flooded and the
  exit held over 14,000 entries. At this scale it is below the noise.
- Closed connections are not bounded: one machine opening and closing about 1,300 connections a second leaves about
  20,000 entries in each table. At the kernel's default 120 s (TIME_WAIT), kept up towards many destinations, one
  machine could hold over 150,000 of the node's 262,144, and the same entries hold the exit's masqueraded source
  ports towards each destination, which every company on the node shares. So agent TCP connections are held 30 s
  once closed, in both tables (`ct timeout agent_tcp`, set for new agent connections only; the node's own traffic
  keeps the defaults): a quarter of that. Measured on 4 October (run 20261004T013618-56993-344f627b, the same
  throwaway VM): 5,000 connections left 4,995 TIME_WAIT entries in each table, and 35 seconds later none. The line
  guard's burst brake (E7) bounds the rate itself; phase 2 (E9) drops the node's leg altogether.

## Notes for later steps

- E3 (log shipping): rotate `dns.log` by copying and truncating it, not by renaming it and sending SIGUSR2. dnsmasq's
  unprivileged user cannot create a file in the 0750 log directory, so a reopen would fail and logging would stop.
- The per-machine connection bound counts per address; the bridge rules and LXD's MAC filter pin each machine to its
  address. A reload of the rules starts both counts again from zero, and recreates the 30 s timeout policy: the
  connections open at that moment close into the kernel's 120 s. 30 s is the trade-off of many NAT gateways: a site
  that closed first and still holds TIME_WAIT may see the same public port again within 30 to 60 s and delay that one
  connection about a second, against a quarter of the entries and ports held. The node's table holds 262,144 entries
  (read on both nodes, 2 October); with `notrack` it holds only the masqueraded leg of each agent connection. Closed
  connections are not bounded but leave after 30 s (E2b's floods above; E7's brake bounds their rate). Proofs that
  change a kernel run in a throwaway VM inside a test machine, never bare on it: loading or unloading kernel modules
  there changes the whole test machine (`modprobe -r br_netfilter` also unloads `bridge`, which destroys every bridge
  on it).
- E2c: a creator calls `plug` right before each create, after the old instance (if any) is gone, and never reuses
  an address it stored (`plug` is the only source of a machine's address). Plugging while the old instance still
  exists, then deleting and making it again, can let the reconciler unplug the address in between. Its unit joins the
  group, may write `clients/` and `dhcp-hosts/`, and reads `plug.lock`, `quarantine/` and `seen/`. The node inventory
  pins a machine's devices when it first sees it, so the plug is never added to a machine that exists.
- The refused-flow log: a flow is logged when it is first refused and again each time it is added back after its hour
  runs out. Refusals the exit could not keep (a machine's share spent, or a set full) are counted in
  `refused_unlogged`, and the logger writes a gap line for them.
