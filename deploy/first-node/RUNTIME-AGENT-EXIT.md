# Agent exit

Status: designed and approved, not built. Jonas decided on 2 October 2026 that agent traffic leaves through our own
controlled exit with its own public address ("completely agree… let's fix this"), and approved the design page
(https://claude.ai/artifact/GPjfKe2YagNeMzkQMrY95r). The page's four choices were set as recommended by the runtime
coordinator on 3 October 2026, at Jonas's request; Jonas may still change any of them. The contract text is
the "2026-10-03 amendment: agent traffic leaves through the agent exit" in section 19 of
`QORPERA-RUNTIME-CONTRACT.md`. Where this document and the contract differ, the contract governs.

Details the page did not show are marked **proposed**. They can change in review without a new founder decision, as
long as they keep the page's rules. Two rules the page did not cover, the connection bounds (§3) and the
log-outage rule (§12), were decided by the runtime coordinator on 3 October on Jonas's standing request that it settle
his open questions; he may still change them.

## 1. Why

Both nodes sit on the office network behind one TDC router and leave from one address, 93.164.62.162. Agents, our
builds, our tests, GitHub and AI sign-ins all share it. Once other companies run on Qorpera, one company's agent could
get that address blocked, and our own platform work would stop with it. The trigger was GitHub refusing the Company
Computer on 2 October. The coordinator's GitHub block report of that day found the cause was the browser announcing
automation, not the address. So the exit is about isolation, policy, audit and reputation separation. It is not
about getting past bot checks (§9).

Step E-1, the guest guard (`deploy/guest-guard/`, enforcing on both nodes since 2 October), already keeps every guest
on our bridges away from the NAS, the nodes and every tailnet service it does not list. It stays for our own guests
(execution hosts, job VMs, builders, the test machine). The exit adds the second address, the per-company log and
rules, and the line guard.

## 2. Two roads

The **agent road machines** are the Company Computer (its browser, shells, terminal and desktop), agents' own
machines, coding machines, and any other machine that gets a network later. The platform's own services keep the platform road, even
when they act for an agent.

| Traffic | Road | How |
| --- | --- | --- |
| Company Computer browser | agent | the browser relay's connections leave through the computer's agent plug (§6) |
| Company Computer shells, terminal, desktop | agent | #411's per-screen namespaces route out of the agent plug (§6) |
| Agents' own machines | agent | their only network card is an agent plug |
| Coding machines: git, registries, websites | agent | their only network card is an agent plug |
| Coding turns: AI sign-in and model traffic | platform | the model program runs on the execution host: the existing model relay (§5) |
| Chat turns on execution hosts (light threads) | platform | no commands; the existing model relay |
| Vault, official connections, sign-in helper, coding pushes, mail | platform | node host and mail provider |
| Database, object gateway, Tailscale | platform | as today |
| Test machine, image builds | platform | as today, behind the guest guard |
| A Company Computer's own services (database, files, NAS workbench) | platform | the computer's first network card on `qorpera0` |

## 3. The exit on a node (E1)

Every node runs the same exit with the same inside addresses (below). Each node's public address differs (§11). An
agent road machine only ever uses the exit of the node it runs on.

**Layout (proposed).**
- A network namespace `qexit`.
- A Linux bridge `qagent0` in the host namespace. The host has no address on it, so agent road machines cannot reach
  any host service. Agent plugs (§4) attach to it.
- A veth pair `qx-br` (host, a port of `qagent0`) / `br0` (in `qexit`). `br0` holds `10.210.0.1/16`, the agents'
  gateway. Agent road machines get addresses from `10.210.0.0/16`.
- An uplink:
  - Phase 1, until TDC delivers the block: a veth pair `qx-up` (host, `10.209.255.1/30`) / `up0` (in `qexit`,
    `10.209.255.2/30`, default route via the host). The exit masquerades to `10.209.255.2`; the host masquerades
    that address out of its own uplink, so traffic leaves from 93.164.62.162. No router change.
  - Phase 2 (E9): a macvlan `up0` on the host's LAN NIC holding the node's public address from the block, with the
    router's address in the block as default route. The host no longer forwards agent traffic at all.

**Rules in `qexit` (nftables, `inet qorpera_agent_exit`).**
- From `br0` to `up0`: the source must be in `10.210.0.0/16`; our own networks are refused (the guest guard's
  `internal4` set plus our public addresses, and the agent addresses once in use); TCP port 25 is refused; IPv6 is
  dropped; invalid packets are dropped; everything else passes. Refusals answer at once (TCP reset or ICMP
  admin-prohibited).
- To the exit itself from `br0`: DHCP, DNS and ping to `10.210.0.1` only.
- From `up0`: replies only.
- Every new connection is counted per client address, and each refused flow is kept an hour for the log (added once
  per hour, not refreshed on every hit; only a new flow spends a machine's share of the log, so repeats cannot hide
  other refusals).
- Decided by the runtime coordinator on 3 October (contract item 4; Jonas may change them): each client holds at
  most 16,384 open connections through the exit at once, and the exit at most 98,304 in all; the per-machine bound
  is checked first. In phase 1 each agent connection takes one entry in the exit's connection table and one, the
  masqueraded leg, in the node's (262,144, read on both nodes on 2 October); the node does not track the bridged
  leg (see the host's rules below). The total bounds open connections only: closed agent TCP connections stay in the
  tables for 30 seconds (shortened from the kernel's 120 by a timeout policy for agent connections in both tables),
  and refused attempts leave no entry (measured in E2's proof). When one company reaches the total, every other
  company's new connections on that node are refused until connections close. A Company Computer machine's
  computers share one 16,384. A reload of the rules starts both counts from zero, and connections already open are
  never counted (their packets pass before the bounds are checked); it also recreates the timeout policy, so
  connections open at that moment close into the kernel's 120 seconds. E2's proof on LXD measured the tables under
  such floods and the cost of the shared total.
- Plain DNS sent to any other resolver is redirected to the exit's own.
- Masquerade out of `up0`.

**Rules on the host (nftables, `inet qorpera_agent_exit_host`).** A second line: the host forwards from `qx-up`
only to public addresses and never delivers anything from `qx-up` or `qagent0` to itself; nothing starts a connection
into `qx-up`. It masquerades `10.209.255.2` out of the node's uplink (phase 1 only). With br_netfilter (on our
nodes), traffic between an agent road machine and the exit's `br0` is bridged and passes the host's hooks. No host
rule refuses it, and the host does not track it (`notrack` for everything that enters from `qagent0`, E2): the exit
tracks and bounds each agent connection in its own namespace, and the node's table would otherwise hold a second
entry for each one, and for every attempt the exit refuses or drops, outside the exit's bounds. Untracked packets
are neither established nor related, so the host's own input still drops everything from `qagent0`. The guest
guard must never list `qagent0`: it would refuse that bridged traffic as a private destination.

**Name lookups and addresses (dnsmasq).** `dnsmasq-base` runs in `qexit` on `10.210.0.1`:
- DHCP with static leases only, from a hosts directory the agent plug writes (§4);
- DNS forwarded to public resolvers (proposed: 9.9.9.9 and 1.1.1.1) through the uplink;
- every query logged.

**Connection log (conntrack).** `conntrack -E` in `qexit` (with connection accounting on and a large event buffer)
reports each connection's start and end with bytes each way. A logger writes them, and the refused flows, as JSON
lines (§7). When the kernel drops events under load, conntrack says so, and the logger writes a gap record.

**Units (proposed).**
- `qorpera-agent-exit.service` (oneshot). Start builds or repairs the namespace, bridge, veths, addresses and rules.
  Reload does the same in place. Stop removes the exit and is refused while a machine is plugged in.
- `qorpera-agent-exit-dns.service`, `qorpera-agent-exit-log.service` and `qorpera-agent-plug.service` (the agent
  plug's reconciler, §4, after LXD), wanted by it and ordered after it, but not bound to it.
- `qorpera-agent-exit-health.timer` runs `verify` every 10 seconds and writes its answer for the node observer.
- The coordinator installs them with `deploy/agent-exit/install-agent-exit.sh`, and they stay disabled until a node
  is switched on. With a machine plugged in (in the client map, running or asleep), stopping the exit's unit fails
  and changes nothing: the name, log and plug services are not bound to it and keep running. The unit is then marked
  failed; `systemctl start` brings it back in place. The undo, with nothing plugged in: disable and stop the health
  timer and the exit's unit (its stop also stops the name, log and plug services), then disable those three. They
  are never stopped by name while a machine is plugged in, because traffic would then flow without names and without
  the log, and nothing would flush or unplug machines.
- Packages: `dnsmasq-base`, `conntrack` and `python3` (no services of their own).

**Boot.** The exit's unit is ordered before LXD, so the bridge exists before LXD starts a machine that plugs into
it. LXD used to turn on IPv4 forwarding; the exit now does it itself when it starts first, and then sets the agents'
bridge back to no forwarding.

**Updates (contract item 10).** An exit update never stops a machine:
- it reloads the rules in one transaction per table, before any link is touched;
- it restarts dnsmasq and the logger in place;
- it keeps the bridge and the veths.

Running machines keep their links through it, so no company is paused. A change that would have to rebuild the
namespace is not made while a machine is plugged in; the tool refuses it and has no override.

**Health.** `qorpera-agent-exit.sh verify` checks the namespace, the bridge, the three rule tables, dnsmasq (in the
exit's current namespace), the logger's heartbeat and the agent plug's reconciler (alive, and the client map true to
LXD, §4). The logger leaves by itself when its reader watches a namespace the exit replaced. The health timer writes
`verify`'s answer to `/run/qorpera-agent-exit/health.json`, because the node observer has no capabilities and
cannot run `verify` itself. The observer reports it, and placement gives agent road machines only to nodes with a
healthy exit (E2).

## 4. The agent plug (E2)

- An LXD NIC with `nictype: bridged` and `parent: qagent0`. It has `security.mac_filtering`,
  `security.ipv6_filtering` and `security.port_isolation`, `ipv6.address: none`, and a `hwaddr` made from the
  machine's address in the node's pool `10.210.0.0/16` (outside `10.210.0.0/24`, kept for the exit's own services):
  `0e:51:` and the address's four bytes, a locally administered MAC. The MAC is part of the machine's config for its
  whole life; the address lives in the client map, the lease and the bridge rules, all tied to that MAC. The card
  carries no `ipv4.address`: LXD 6.9 refuses one on a bridge it does not manage unless its own IPv4 filter is on
  (E2b's proof on LXD, 4 October).
- Not `security.ipv4_filtering`: LXD's IPv4 filter has no DHCP exception in its forward chain, so on a bridge LXD does
  not manage it drops every DHCP request on its way to the exit (seen on LXD 6.9 in a test machine, 3 October, and in
  LXD's rule template). The exit's own bridge rules (`qorpera-agent-exit-bridge.nft`, bridge family, on the node) take
  its place. Before the bridge learns where a MAC lives, a machine's port may send only its own MAC (a set of LXD
  ports and MACs), so no machine can take another's MAC, or the exit's, and with it their traffic; LLDP frames, which
  would otherwise skip the bridge's hooks, are forwarded through them (`group_fwd_mask`), and no link-local frame
  teaches the bridge a MAC. A machine's frames go only to the exit's port, and the exit's frames only to the port of
  the machine they are addressed to (broadcasts to all): a frame to a MAC the bridge has forgotten is flooded to every
  port, and port isolation does not stop frames from the exit's port. Then a frame from a machine passes only as ARP
  (its sender fields too) or IPv4 from a MAC and address pair, and DHCP only through one rule per machine: its own
  MAC, from no address or its own, naming its own MAC as the client (BOOTP chaddr). So no machine can take, release or
  decline another's lease (dnsmasq holds back a static address for 10 minutes after a DHCPDECLINE that names it), and
  dnsmasq ignores client ids, so a lease is the MAC's alone. Only entries LXD backs are in the sets: a card outside
  the map, not in it yet, or claimed by an entry LXD does not back, gets no address and nothing through. With LXD's
  MAC filter (each port keeps its own MAC) that ties each machine to its address. The node takes nothing from the
  bridge.
- The plug is part of each machine creator's own plan, not added afterwards. The creators check their machine's exact
  devices: `lxd-office-guest.ts`, `coding-machine.ts` and `company-machine.ts` each compare the NIC set they expect.
  The node inventory also pins a machine's devices when it first sees the machine, and a card changed later makes the
  node unavailable; so the plug goes in when a machine is made, never later. With no users and no legacy machines
  (founder decision, 3 October: production's companies are wiped and legacy compatibility is dropped), there is
  nothing to migrate: the creators of the new architecture plug every machine in from the start. A creator calls
  `plug` right before each create, after the old instance (if any) is gone, and never reuses a stored address. The
  Company Computer keeps its first card, `network` on `qorpera0`, for its own services (the passthrough finds it by
  that name); the plug is its second card.
- One shared helper, `deploy/agent-exit/qorpera-agent-plug.py plug`, run by the creators (members of the group
  `qorpera-agent-plug`) before they create a machine: it takes the lowest free address that is not in quarantine
  (each entry is created exclusively, so two creators never share one), and writes the client map entry (address,
  MAC, kind, company, machine, member for coding machines, LXD project and instance, since) and the DHCP lease,
  which dnsmasq reads by itself. Asked again for the same instance, it gives the same answer.
- The rest is the reconciler's, a root unit that reads LXD every 5 seconds. A creator makes no other call: sleeping,
  waking and deleting need no hook, and a crash cannot leak an address. It checks every entry against its machine's
  LXD config (the card, the company, the machine, the member), that a running machine's card is a port of
  `qagent0`, and that every machine on `qagent0` has an entry; anything else makes the exit unhealthy. It keeps the
  bridge rules equal to the entries LXD backs and their machines' ports.
- Creators write the entries, so an entry is a claim until the reconciler matches it with LXD. The client history,
  `clients-YYYY-MM-DD.jsonl` beside the flow log, ties an address to a company only for a matched entry
  (`plugged`, from the entry's time, then `unplugged`). An entry LXD does not back gets a `mismatch` line (the claim,
  what LXD says, the problems) and is never attributed; one that goes without ever matching is `dropped`; a machine
  on the bridge without an entry is `unattributed`. E3's lookup reads these lines, so a forged entry can never put
  another company's name on traffic, and an address stays tied to its company also after the machine is gone.
- A sleeping machine keeps its address and its entry; its connections are flushed when it sleeps, so stale entries
  never hold its connection bound. When a machine goes away (missing from two reads of LXD in a row after it was seen,
  or never created within an hour of its last plug), the reconciler unplugs it under the plug lock: its address is
  quarantined first, then its lease is removed (dnsmasq reloads), its connections and the exit's per-machine counts
  and refused flows are cleared, and its entry is removed. A machine made again under the same name gets its entry
  back from `plug` with a new time, and is not unplugged in between. A flush that fails is tried again every pass, and
  its address is not given out until it succeeds. The address stays unused for 15 minutes, longer than a DHCP lease
  (10 minutes), so late log lines are never given to the wrong company and the address is free again before it is
  reused.
- A flush ends the address's connections in the exit's table and their masqueraded twins in the node's (phase 1),
  found through the exit's masqueraded port. Twins of other protocols than TCP, UDP and ICMP have no port to find
  them by and end with their timeout.
- "Plugged in" means any machine in the client map, running or asleep. E2's guard on removing the exit reads the
  client map, not only the bridge's ports (a sleeping machine has no port).
- No switches: each kind's creator plugs its machines in from its own step (E2c onwards).
- Today agents' machines and coding machines have LXD ACLs on `machine-net` and `coding-net` as their second line.
  On `qagent0` the exit's, the bridge's and the host's rules take that place, with LXD's MAC and IPv6 filters and
  port isolation.

## 5. The provider door (dropped for now)

The first version of this design assumed that a coding machine runs its model program itself. It does not: a coding
turn's harness (Codex or Claude Code) runs on the execution host like any other run, and its sign-in and model traffic
leave through that host's model relay (`packages/runtime/src/cloud-native-egress.ts`). The coding machine only runs
the turn's commands (`deploy/coding-worker/README.md`, "Execution path"). So that traffic never reaches the exit, and
no door is built (corrected 3 October in step E2a, accepted by the runtime coordinator).

If one of our model programs ever runs inside an agent road machine, a door for it is designed and built before that
machine moves to the exit. The first proposal stands as a starting point: a pass-through in a namespace of its own
with an address on `qagent0`, reading only the TLS server name, passing only the providers' names and connecting out
from the platform address, with the machine's provider names pointed at it. Until then an agent's own calls to an AI
service, from any agent road machine, are agent traffic like any other.

## 6. The Company Computer (E6)

The machine behind the Company Computer gets a second network card, an agent plug, in the next office image (with
#411).

**Inside the computer.**
- The browser relay's outbound connections and #411's per-screen namespaces route out of the agent plug.
- A rule in the computer drops their traffic if it would leave by the first card, so a routing fault fails closed.
  Agents cannot change these rules. E6 proves both, because the host's guest guard still lets the computer's first
  card reach any public address for its own services.
- The relay resolves names through the exit's DNS.
- #411's in-guest filter blocks `10.0.0.0/8`, so it must allow the exit's DNS on `10.210.0.1`. #411's shells use that
  DNS instead of 1.1.1.1 and 8.8.8.8.
- The computer's own services keep the first card on `qorpera0` (database, object gateway, NAS workbench).

**The office gate.** Today it requires a managed LXD bridge with NAT (`lxd-client.ts`, the managed-bridge check),
refuses ACL bridges, and fingerprints the network configuration (`lxd-office-node-base.ts`). It learns `qagent0`, an
unmanaged bridge, in the same image and policy change.

**The browser.** E6 adds a managed browser policy that keeps encrypted ClientHello off, so TLS server names stay
visible to the exit (they matter for the "only listed" mode, §10).

## 7. The log (E3, choice 3)

- One JSON line per event (proposed):
  - a connection's start and its end, with bytes and packets each way: `{ts, event, node, company, machine, kind,
    src, dst, sport, dport, proto, name, bytes_out, bytes_in}`;
  - a refused flow, the first time in an hour, with the rule that refused it;
  - a gap: a time the log could not record (the logger down, or events lost under load). For an abuse lookup a gap
    means unknown, never "no one".
- `name` comes from the exit's DNS log: the last name that resolved to `dst` for that client.
- Never content, never full web addresses, never decrypted.
- The log and the DNS record are kept 90 days on our storage (a platform folder on the NAS, per node and day), then
  deleted.
- A lookup script answers "who used address X at time T".
- A company's owners and admins see their company's log, and a member sees the lines of their own coding machine,
  in a view that comes later with its own interfaces amendment (E10).
- A refused connection tells the agent only that it was refused. The rule is in the log.

## 8. The line guard (E7, choice 2)

- TCP port 25 is refused from day one (in E1).
- For two weeks the exit only counts, per company:
  - new connections;
  - refused connections;
  - bursts of new connections (a flood);
  - failed connections to many addresses (a scan).
- The founder sees the numbers and decides the brake's levels, well above normal use.
- Past those levels, that company's new connections are slowed for a while.
- The brake never stops normal work and is not a count on a run's work (contract 7.4).

E7 built the brake (`deploy/agent-exit/README.md`, "The brake"). It is off on each node until the levels are set there:
- **The levels.** N new connections in 10 seconds and F failed destinations (unanswered or refused) in a minute; either
  may be left out. While braked, the company's machines share S new connections per 10 seconds (S under N), for M
  minutes.
- **The guard** lives in the connection logger and counts each company's lines as the counts do. A company past a
  level is braked for M minutes, and longer while it stays past one. A machine's company is the plug's own copy of its
  entry, as for the log.
- **Braked**, a company's new connections past its share are dropped, and its machines try again a little later, as on
  a busy line. Nothing is refused for good. Open connections and what goes to the exit itself (names, DHCP, ping) are
  never touched, and other companies neither.
- **A dropped connection counts as a new one,** once however often it is resent. So a company that keeps pushing stays
  braked, and one that slows down is let go.
- **In the log:** a "braked" line when a brake starts and an "unbraked" line, with how many connections it dropped,
  when it ends. The day's counts carry both.
- **Failure.** A brake ends on time in the exit's rules also while the logger is down. A level that is not well formed
  turns the brake off and makes the exit unhealthy until it is fixed.

## 9. What the exit is not

The exit never uses:
- stealth browser flags or fake browser identities;
- rotating or residential addresses;
- CAPTCHA solving.

A block page or a CAPTCHA means stop, never retry. Strict sites stay a person's task in their own browser
(`deploy/first-node/RUNTIME-COMPANY-ACCOUNTS.md`). Once the block is in use, the agent addresses carry reverse names
under qorpera.com and a page that explains the traffic with an abuse contact.

## 10. Company rules (E8, choice 4)

`rules/network.toml` in the company folder:

```toml
mode = "open"                                     # or "only-listed"
block = ["casino.example", "*.torrents.example"]  # refused in both modes
allow = ["github.com"]                            # the only names reached in "only-listed"
```

E8 lands in three PRs: E8a, the file, its check and the rules the nodes read; E8b, per-company names on each node's
exit; E8c, "only listed".

- **Names.** A name covers itself and every name under it (`github.com` covers `api.github.com`); `*.` in front
  covers only the names under it. A name is written in lowercase, without `https://`, a path, a port or the dot at
  the end, and is never an address: a site's addresses change. A list holds at most 1000 names, each once.
  - A name in both lists is refused. A blocked name stays refused when `allow` covers it through a wider name, so
    the block wins.
  - `allow` does nothing in "open", so a list is kept while the mode changes.
  - Every key may be left out. The defaults are "open" and empty lists, and a company without the file is open.
- **Who.** Owners and admins write, delete and restore it. Agents and the other members read it and never write it
  (contract 5.6). It never moves (not even onto its own path) or is copied, no other file moves or is copied onto
  its path, and no folder takes its name. Such a change is refused with a problem, as any rule is.
- **The check (E8a).** It is not a review rule: the reviewer does not read it. The folder treats it as its own checked
  kind, `network-rules`, read by one parser in every writer (`packages/cloud-client/src/network-rules.ts`). The
  database checks the parse's shape again with the same name rule and refuses a save that fails. Each save keeps the
  rules in `qorpera_company_network_rules`, one row per company folder, and a delete removes the row.
- **How the nodes read it (E8a, E8b).** A database role of its own, `qorpera_agent_exit`, may call one function and
  nothing else: `qorpera_agent_exit_network_rules(companies)` returns each listed company's current rules (a
  version, the mode and both lists). It reads no table. E8a's migration creates the role without a login. At rollout
  the coordinator sets its login secret on each node with a root script and places it for the exit's
  `LoadCredential`; nobody reads or prints it. The exit asks about every 2 seconds and applies a change at once.
- **Per-company names (E8b).** One dnsmasq cannot hold a list per company. E8b runs a small dnsmasq for each company
  that has rules, in the exit's namespace: its servers file answers a blocked name with "no such name" and sends the
  rest to the exit's upstreams, and a changed list reloads it without a restart. The exit sends each machine's
  lookups to its company's resolver, by the client map (a machine's company is its LXD `user.qorpera.company_id`).
  A machine whose company has rules gets no answers until that resolver runs. A blocked name lands in the
  name-lookup record.
- **Block list:** the exit's DNS refuses a blocked name for that company's machines. No address is blocked, so other
  sites behind the same CDN are untouched. A machine that reaches a site by address, or through its own encrypted
  DNS, gets past a block list.
- **"Only listed" (E8c):** strict. A machine reaches only TCP port 443, only on addresses the exit's own lookups gave
  for a listed name (a per-company set that the company's resolver fills as names resolve), and only when the TLS server name is listed too, so an
  unlisted site that shares a listed site's address is refused. E8 adds that check as a pass-through that reads only
  the server name, like the model relay's check. Everything else is refused in this mode: plain HTTP, other ports and
  protocols, UDP (QUIC) and SSH included. The exit never decrypts, so domain fronting (a listed TLS name carrying
  another site inside) is not caught.

## 11. The address block (E9, choice 1)

- A block of 8 fixed IPv4 addresses (/29) from TDC, routed to our line:
  - five usable, one per node (room for four nodes) and a spare;
  - TDC lists holders of 8 or more addresses publicly with RIPE (name, address, phone), so the block is visibly
    Qorpera's.
- Jonas sends the Danish message on the design page. TDC's answer settles how the block reaches the router and who
  sets the router up.
- Each node switches in place: `up0` becomes a macvlan with the node's address, and the host's masquerade for the
  exit is removed. Connections open at that moment end, and new ones start from the new address. Sites that tie a
  sign-in to an address may ask an agent's session to sign in again, and a machine set up on another node leaves
  from that node's address.
- Reverse names under qorpera.com, and the info page with the abuse contact.
- TDC's terms say the line may not carry traffic for anyone but the customer. The TDC message asks TDC to confirm
  that a hosted service is fine.

## 12. Failure model

- **Exit down on a node.** That node's agent road machines have no internet, and agent traffic never falls back to
  the platform road.
  - The node observer reports the failed `verify` to the runtime operator, and placement gives that node no new
    agent road machines.
  - Agents' commands on that node see network errors.
  - Recovery: `systemctl reload qorpera-agent-exit.service` (or `systemctl start` when the unit is marked failed)
    repairs the exit's own parts in place. If the bridge
    itself was lost, plugged machines lose their links until they restart; E2's `verify` checks that every plugged
    machine's network card is on the bridge. If repair fails, the operator moves the node's work as for any node
    fault.
- **Uplink down.** The same as the exit being down.
- **Log down (decided by the runtime coordinator on 3 October).** Traffic continues, the exit's refusals stay in
  force, the time is a gap in the log, and `verify` fails, with the consequences above (no new machines, a report to
  the operator). A short gap in the log is preferred over cutting running work; the contract's item 10 says so, and
  Jonas may change it. The gap record written when the logger
  starts again carries `since` (its last heartbeat), so a lookup marks the whole outage as unknown; after a reboot
  there is no heartbeat, and the outage runs from the last line written. Other gap records (lost events, unlogged
  refusals) mark a moment; E3 reads them as unknown back to the line before.
- **Rule change.** Applies within seconds (the exit reads the rules, the resolver reloads its lists and the exit its
  sets), without a restart.
- **Update.** In place (§3), with no machine stopped and no company paused.

## 13. Build plan

| Step | What | Changes for companies |
| --- | --- | --- |
| E-1 | Guest guard: guests off the NAS, the nodes and unlisted tailnet services (#684) | done, enforcing since 2 October |
| E0 | This document and the contract amendment | none |
| E1 | The exit on a node: namespace, bridge, uplink, both rule tables, DNS and DHCP, connection log, units, `verify`; proven on the node 2 test machine; switched off | none |
| E2 | The agent plug in each machine creator's plan, the client map, exit health in placement | none until a milestone release installs it |
| E3 | Log shipping to the NAS, 90-day cleanup, the "who used this address" lookup | none |
| E4 | Agents' machines use the agent plug | made with it |
| E5 | Coding machines use the agent plug | made with it |
| E6 | Company Computer: a second network card for the browser, shells, terminal and desktop (with the next image) | made with it |
| E7 | Line guard: counting (with E3's tender), then the brake, built and off, at the levels the founder decides | after his decision |
| E8 | Company rules: E8a the file, its check and the rules the nodes read; E8b per-company names; E8c "only listed" | rules work |
| E9 | The address block: switch-over per node, reverse names, info page | new address |
| E10 | Each company's own log view (its own interfaces amendment) | companies see it |

Each step is a small PR with an exact-head independent review and a `run-on-node.mjs changed` run on the node 2 test
machine. The coordinator merges and installs.

E2 lands in four PRs: E2a, the node's side (the plug tool and its reconciler, the bridge rules that tie each MAC
to its address, `notrack` for the bridged leg, the health file); E2b, the proof on LXD in a throwaway VM inside a
test machine (the NIC filters, port isolation, the spoofs, the floods and the tables); E2c, the plug in the agents' and
coding machines' creators (the Company Computer's card comes with E6 and its next image); E2d, exit health in placement. With no users and no legacy machines (founder decision, 3 October),
neither keeps a switch.
