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
  leg (see the host's rules below). The total bounds open connections only: closed connections (120 seconds by
  default) and refused attempts (10 seconds for TCP, 30 for UDP, 600 for other protocols) stay in the tables for a
  while. When one company reaches the total, every other company's new connections on that node are refused until
  connections close. A Company Computer machine's computers share one 16,384. A reload of the rules starts both
  counts from zero, and connections already open are never counted (their packets pass before the bounds are
  checked). E2's proof on LXD measures the tables under such floods and the cost of the shared total.
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

**Health.** `qorpera-agent-exit.sh verify` checks the namespace, the bridge, both rule tables, dnsmasq (in the
exit's current namespace), the logger's heartbeat and the agent plug's reconciler (alive, and the client map true to
LXD, §4). The logger leaves by itself when its reader watches a namespace the exit replaced. The health timer writes
`verify`'s answer to `/run/qorpera-agent-exit/health.json`, because the node observer has no capabilities and
cannot run `verify` itself. The observer reports it, and placement gives agent road machines only to nodes with a
healthy exit (E2).

## 4. The agent plug (E2)

- An LXD NIC with `nictype: bridged` and `parent: qagent0`. It has `security.mac_filtering`,
  `security.ipv6_filtering` and `security.port_isolation`, `ipv6.address: none`, the machine's `ipv4.address` from
  the node's pool in `10.210.0.0/16` (outside `10.210.0.0/24`, kept for the exit's own services), and a `hwaddr`
  made from that address (`0e:51:` and the address's four bytes, a locally administered MAC). The address and MAC
  are part of the machine's config for its whole life.
- Not `security.ipv4_filtering`: LXD's IPv4 filter has no DHCP exception in its forward chain, so on a bridge LXD
  does not manage it drops every DHCP request on its way to the exit (seen on LXD 6.9 in a test machine, 3 October,
  and in LXD's rule template). The exit's own bridge rules (`qorpera-agent-exit-bridge.nft`, bridge family, on the
  node) take its place: from a machine's port a frame passes only as ARP or IPv4 from a MAC and address pair in the
  client map, or as a DHCP request from a client map MAC; a card outside the map gets no address and nothing
  through. With LXD's MAC filter (each port keeps its own MAC) that ties each machine to its address. The node takes
  nothing from the bridge.
- The plug is part of each machine creator's own plan, not added afterwards. The creators check their machine's exact
  devices: `lxd-office-guest.ts`, `coding-machine.ts` and `company-machine.ts` each compare the NIC set they expect.
  The node inventory also pins a machine's devices when it first sees the machine, and a card changed later makes
  the node unavailable; so E5 and E6 settle how coding machines and Company Computers that already exist are made
  again with the plug. Legacy `coding-vm.ts` machines are retired, not moved. The Company Computer keeps its first
  card, `network` on `qorpera0`, for its own services (the passthrough finds it by that name); the plug is its
  second card.
- One shared helper, `deploy/agent-exit/qorpera-agent-plug.py plug`, run by the creators (members of the group
  `qorpera-agent-plug`) before they create a machine: it takes the lowest free address that is not in quarantine
  (each entry is created exclusively, so two creators never share one), and writes the client map entry (address,
  MAC, kind, company, machine, member for coding machines, LXD project and instance, since) and the DHCP lease,
  which dnsmasq reads by itself. Asked again for the same instance, it gives the same answer.
- The rest is the reconciler's, a root unit that reads LXD every 5 seconds. A creator makes no other call: sleeping,
  waking and deleting need no hook, and a crash cannot leak an address. It checks every entry against its machine's
  LXD config (the card, the company, the machine, the member), that a running machine's card is a port of
  `qagent0`, and that every machine on `qagent0` has an entry; anything else makes the exit unhealthy. It keeps the
  bridge rules' sets equal to the client map.
- Creators write the entries, so an entry is a claim until the reconciler matches it with LXD. The client history,
  `clients-YYYY-MM-DD.jsonl` beside the flow log, ties an address to a company only for a matched entry
  (`plugged`, from the entry's time, then `unplugged`). An entry LXD does not back gets a `mismatch` line (the claim,
  what LXD says, the problems) and is never attributed; one that goes without ever matching is `dropped`; a machine
  on the bridge without an entry is `unattributed`. E3's lookup reads these lines, so a forged entry can never put
  another company's name on traffic, and an address stays tied to its company also after the machine is gone.
- A sleeping machine keeps its address and its entry; its connections are flushed when it sleeps, so stale entries
  never hold its connection bound. When a machine goes away (missing from two reads of LXD in a row after it was
  seen, or never created within an hour of its plug), the reconciler unplugs it under the plug lock: its address is
  quarantined first, then its lease is removed (dnsmasq reloads), its connections and the exit's per-machine counts
  and refused flows are cleared, and its entry is removed. A machine made again under the same name gets its entry
  back from `plug` with a new time, and is not unplugged in between. A flush that fails is tried again every pass,
  and its address is not given out until it succeeds. The address stays unused for 15 minutes, longer than a DHCP lease (10 minutes), so late log
  lines are never given to the wrong company and the address is free again before it is reused.
- A flush ends the address's connections in the exit's table and their masqueraded twins in the node's (phase 1),
  found through the exit's masqueraded port. Twins of other protocols than TCP, UDP and ICMP have no port to find
  them by and end with their timeout.
- "Plugged in" means any machine in the client map, running or asleep. E2's guard on removing the exit reads the
  client map, not only the bridge's ports (a sleeping machine has no port).
- Machines move one kind at a time, each behind its own switch. A running machine moves the next time it starts.
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

## 9. What the exit is not

The exit never uses:
- stealth browser flags or fake browser identities;
- rotating or residential addresses;
- CAPTCHA solving.

A block page or a CAPTCHA means stop, never retry. Strict sites stay a person's task in their own browser
(`deploy/first-node/RUNTIME-COMPANY-ACCOUNTS.md`). Once the block is in use, the agent addresses carry reverse names
under qorpera.com and a page that explains the traffic with an abuse contact.

## 10. Company rules (E8, choice 4)

`rules/network.toml` in the company folder (proposed format):

```toml
mode = "open"          # or "only-listed"
block = ["casino.example", "*.torrents.example"]
allow = []             # used when mode is "only-listed"
```

- It is written, moved, deleted and restored only by owners and admins. Agents read it and never write it (contract
  5.6).
- It is not a review rule: the reviewer does not read it. Today the folder code treats only `rules/*.md` as rules, so
  E8 adds the file as its own checked kind. A save that fails the check is refused, and a company without the file
  is open.
- The platform projects it to every node.
- **Per-company names (proposed).** dnsmasq cannot hold a list per company. E8 puts a resolver with per-client policy
  in front of or in place of dnsmasq's DNS (for example unbound views keyed by client address from the client map).
  A changed list reloads without a restart, and a blocked name lands in the name-lookup record.
- **Block list:** the exit's DNS refuses a blocked name for that company's machines. No address is blocked, so other
  sites behind the same CDN are untouched. A machine that reaches a site by address, or through its own encrypted
  DNS, gets past a block list.
- **"Only listed":** strict. A machine reaches only TCP port 443, only on addresses the exit's own lookups gave for
  a listed name (a per-company set filled as names resolve), and only when the TLS server name is listed too, so an
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
- **Rule change.** Applies at once (the resolver reloads its lists and the exit its sets), without a restart.
- **Update.** In place (§3), with no machine stopped and no company paused.

## 13. Build plan

| Step | What | Changes for companies |
| --- | --- | --- |
| E-1 | Guest guard: guests off the NAS, the nodes and unlisted tailnet services (#684) | done, enforcing since 2 October |
| E0 | This document and the contract amendment | none |
| E1 | The exit on a node: namespace, bridge, uplink, both rule tables, DNS and DHCP, connection log, units, `verify`; proven on the node 2 test machine; switched off | none |
| E2 | The agent plug in each machine creator's plan, the client map, exit health in placement | none (switched off) |
| E3 | Log shipping to the NAS, 90-day cleanup, the "who used this address" lookup | none |
| E4 | Agents' machines use the agent plug | they start there |
| E5 | Coding machines use the agent plug (made again with it) | they move |
| E6 | Company Computer: a second network card for the browser, shells, terminal and desktop (with the next image) | it moves |
| E7 | Line guard: counting, then the brake at the levels the founder decides | after his decision |
| E8 | Company rules | rules work |
| E9 | The address block: switch-over per node, reverse names, info page | new address |
| E10 | Each company's own log view (its own interfaces amendment) | companies see it |

Each step is a small PR with an exact-head independent review and a `run-on-node.mjs changed` run on the node 2 test
machine. The coordinator merges and installs.

E2 lands in four PRs: E2a, the node's side (the plug tool and its reconciler, the bridge rules that tie each MAC
to its address, `notrack` for the bridged leg, the health file); E2b, the proof on LXD inside a test machine (the NIC filters, port isolation, the floods and the
tables); E2c, the plug in the three creators' plans; E2d, exit health in placement, with one switch per machine
kind, all off until E4–E6.
