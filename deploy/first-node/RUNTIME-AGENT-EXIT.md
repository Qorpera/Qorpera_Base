# Agent exit

Status: designed and approved, not built. Jonas decided on 2 October 2026 that agent traffic leaves through our own
controlled exit with its own public address ("completely agree… let's fix this"), and approved the design page
(https://claude.ai/artifact/GPjfKe2YagNeMzkQMrY95r). The page's four choices were set as recommended by the runtime
coordinator on 3 October 2026, at Jonas's request; Jonas may still change any of them (§11). The contract text is
the "2026-10-03 amendment: agent traffic leaves through the agent exit" in section 19 of
`QORPERA-RUNTIME-CONTRACT.md`. Where this document and the contract differ, the contract governs.

Details the page did not show are marked **proposed**. They can change in review without a new founder decision, as
long as they keep the page's rules.

## 1. Why

Both nodes sit on the office network behind one TDC router and leave from one address, 93.164.62.162. Agents, our
builds, our tests, GitHub and AI sign-ins all share it. Once other companies run on Qorpera, one company's agent could
get that address blocked, and our own platform work would stop with it. The trigger was GitHub refusing the Company
Computer on 2 October (outputs/GITHUB-BLOCK-REPORT-20261002.md): the cause was the browser announcing automation,
not the address, so the exit is about isolation, policy, audit and reputation separation. It is not about getting
past bot checks (§9).

Step E-1, the guest guard (`deploy/guest-guard/`, enforcing on both nodes since 2 October), already keeps every guest
on our bridges away from the NAS, the nodes and Tailscale. It stays for our own guests (execution hosts, job VMs,
builders, the test machine). The exit adds the second address, the per-company log and rules, and the line guard.

## 2. Two roads

| Traffic | Road | How |
| --- | --- | --- |
| Company Computer browser | agent | the browser relay's connections leave through the computer's agent plug (§6) |
| Company Computer shells (#411) | agent | the per-screen namespaces route out of the agent plug (§6) |
| Agents' own machines | agent | their only NIC is an agent plug |
| Coding machines: git, registries, websites | agent | their only NIC is an agent plug |
| Coding machines: AI sign-in and model traffic | platform | the provider door (§5) |
| Chat turns on execution hosts (light threads) | platform | no commands; the existing model relay |
| Vault, official connections, sign-in helper, coding pushes | platform | node host |
| Database, object gateway, Tailscale | platform | as today |
| Test machine, image builds | platform | as today, behind the guest guard |
| A computer's own services (database, files, NAS workbench) | platform | the computer's first NIC on `qorpera0` |
| Mail | mail provider | unchanged |

## 3. The exit on a node (E1)

Every node runs the same exit. Nothing in it is bound to one node: its addresses are the same on every node, and a
machine only ever uses the exit of the node it runs on.

**Layout (proposed).**
- A network namespace `qexit`.
- A Linux bridge `qagent0` in the host namespace. The host has no address on it, so agent machines cannot reach any
  host service. Agent plugs (§4) attach to it.
- A veth pair `qx-br` (host, a port of `qagent0`) / `br0` (in `qexit`). `br0` holds `10.210.0.1/16`, the agents'
  gateway. Agent machines get addresses from `10.210.0.0/16`, the same range on every node.
- An uplink:
  - Phase 1, until TDC delivers the block: a veth pair `qx-up` (host, `10.209.255.1/30`) / `up0` (in `qexit`,
    `10.209.255.2/30`, default route via the host). The exit masquerades to `10.209.255.2`; the host masquerades
    that address out of its LAN NIC, so traffic leaves from 93.164.62.162. No router change.
  - Phase 2 (E9): a macvlan `up0` on the host's LAN NIC holding the node's public address from the block, with the
    router's address in the block as default route. The host no longer forwards agent traffic at all.

**Rules in `qexit` (nftables, `inet qorpera_agent_exit`).**
- From `br0` to `up0`: the source must be in `10.210.0.0/16`; our own networks are refused (the guest guard's
  `internal4` set plus the node's LAN, our public addresses and the agent addresses); TCP 25 is refused; IPv6 is
  dropped; everything else passes. Refusals answer at once (TCP reset or ICMP admin-prohibited).
- To the exit itself from `br0`: DHCP, DNS and ping to `10.210.0.1` only.
- From `up0`: replies only.
- Every new connection and refusal is counted per client address (dynamic sets with counters), the basis of the line
  guard (§8).
- Masquerade out of `up0`.

**Rules on the host (nftables, `inet qorpera_agent_exit_host`).** A second line: the host forwards from `qx-up`
only to public addresses and never delivers anything from `qx-up` or `qagent0` to itself. It masquerades
`10.209.255.2` out of the LAN NIC (phase 1 only).

**Name lookups and addresses (dnsmasq).** `dnsmasq-base` runs in `qexit` on `10.210.0.1`: DHCP with static leases
only (one file per machine in a hosts directory, written by the agent plug, §4), and DNS forwarded to public
resolvers (proposed: 9.9.9.9 and 1.1.1.1) through the uplink, with every query logged. Plain DNS a machine sends
elsewhere is redirected to it, so the log sees names.

**Connection log (conntrack).** `conntrack -E` in `qexit` (with `nf_conntrack_acct` on) writes one line per
connection as it ends: client address, destination, ports, protocol, bytes each way, start and end. E3 joins these
with the client map (§4) and the DNS log, and ships them (§7).

**Units (proposed).** `qorpera-agent-exit.service` (oneshot: namespace, bridge, veths, addresses, rules; `ExecStop`
removes all of it), `qorpera-agent-exit-dns.service` and `qorpera-agent-exit-log.service`, both bound to it. All are
installed by the node setup and stay disabled until the coordinator switches a node on. Packages: `dnsmasq-base` and
`conntrack` (no services of their own).

**Health.** `qorpera-agent-exit.sh verify` checks the namespace, the bridge, both rule tables, dnsmasq and the logger.
The node observer reports it, and placement gives agent machines only to nodes with a healthy exit (E2).

## 4. The agent plug (E2)

- An LXD NIC `nictype: bridged`, `parent: qagent0`, with `security.mac_filtering`, `security.ipv4_filtering`,
  `security.port_isolation` and IPv6 off, and a static `ipv4.address` from the node's pool in `10.210.0.0/16`.
- One root helper, used by every machine creator (offices, agents' machines, coding machines): `attach` allocates the
  address, adds the NIC, writes the DHCP lease and the client map entry (address → company, machine, kind, since);
  `detach` removes them, flushes the address's connections and keeps it unused for 10 minutes so late log lines are
  never given to the wrong company.
- Machines move one kind at a time, each behind its own switch; a running machine moves the next time it starts.

## 5. The provider door (E5)

A coding machine runs its model program itself. Its sign-in and model traffic must leave from the platform address and
never enter the exit. The door is the existing SNI-checked relay (`packages/runtime/src/cloud-native-egress.ts`) run
as a node service on a second address of `qagent0`, outside `qexit`. The exit's DNS answers the providers' names with
the door's address, and the door connects out from the node's platform address. It lets only the providers' names
through (OpenAI and ChatGPT as today, plus the Anthropic names Claude Code needs) and reads nothing. Traffic an agent
sends to a provider by its own address goes through the exit like any other.

## 6. The Company Computer (E6)

A computer gets a second NIC, an agent plug, in the next office image (with #411). Inside it, the browser relay's
outbound connections and #411's per-screen namespaces route out of the agent plug (policy routing by source); the
computer's own services keep the first NIC on `qorpera0` (database, object gateway, NAS workbench). The office gate
refuses bridges with ACLs and digests network configuration, so it learns `qagent0` in the same image and policy
change. #411's shells use the exit's DNS instead of 1.1.1.1 and 8.8.8.8. The managed browser policy keeps encrypted
ClientHello off, so TLS names stay visible to our own log.

## 7. The log (E3, choice 3)

- One JSON line per connection (proposed): `{ts_start, ts_end, node, company, machine, kind, src, dst, dport, proto,
  name, bytes_out, bytes_in, verdict, rule}`. `name` comes from the DNS log (the last name that resolved to `dst` for
  that client), or the TLS name where it is visible.
- Never content, never full web addresses, never decrypted.
- Kept 90 days on our storage (a platform folder on the NAS, per node and day), then deleted.
- A lookup script answers "who used address X at time T".
- Each company sees its own log later, as a view in Interfaces (E10).

## 8. The line guard (E7, choice 2)

- TCP 25 is refused from day one (in E1).
- For two weeks the exit only counts, per company: new connections, refused connections, and distinct destinations
  with failed connections (the shape of a scan).
- The founder sees the numbers. Then a brake is set well above normal use: past it, that company's new connections
  slow down for a while. It never stops normal work and is not a count on a run's work (contract 7.4).

## 9. What the exit is not

No stealth browser flags, fake browser identities, rotating or residential addresses, or CAPTCHA solving. A block
page or a CAPTCHA means stop, never retry; strict sites stay a person's task in their own browser (A1). The agent
addresses carry reverse names under qorpera.com and a page that explains the traffic with an abuse contact.

## 10. Company rules (E8, choice 4)

`rules/network.toml` in the company folder (proposed format):

```toml
mode = "open"          # or "only-listed"
block = ["casino.example", "*.torrents.example"]
allow = []             # used when mode is "only-listed"
```

- Written, moved, deleted and restored only by owners and admins; agents read it and never write it (contract 5.6).
- The cloud client parses it; the platform projects it to every node; the exit turns names into per-company sets
  through its own DNS.
- "Only listed" adds a TLS-name check on port 443, because shared CDN addresses serve many sites.
- A refusal tells the agent which rule refused.

## 11. The address block (E9, choice 1)

- A block of 8 fixed IPv4 addresses (/29) from TDC, routed to our line: five usable, one per node (room for four
  nodes) and a spare. TDC lists holders of 8 or more addresses publicly with RIPE (name, address, phone), so the block
  is visibly Qorpera's.
- Jonas sends the Danish message on the design page. TDC's answer settles how the block reaches the router and who
  sets the router up.
- Each node switches to its public address while a rolling update has emptied it: `up0` becomes a macvlan with the
  address, and the host's masquerade for the exit is removed.
- Reverse names under qorpera.com, and the info page with the abuse contact.
- TDC's terms say the line may not carry traffic for anyone but the customer; the TDC message asks TDC to confirm a
  hosted service is fine.

## 12. Failure model

- **Exit down on a node.** That node's agent machines have no internet; agent traffic never falls back to the
  platform road. `verify` fails, the observer reports the node, and placement gives it no new agent machines.
  Recovery: restart the unit, or empty the node.
- **Uplink down.** The same as the exit being down.
- **Rule change.** Applies at once through set updates, without a restart.
- **Update.** A node is emptied before its exit changes (rolling updates), so no live agent traffic is cut.
- **Log writer down.** Traffic continues; the gap is visible in the log and in `verify`. (Proposed: a brief gap is
  preferred over stopping agents' work.)

## 13. Build plan

| Step | What | Changes for companies |
| --- | --- | --- |
| E-1 | Guest guard: guests off the NAS, the nodes and Tailscale (#684) | done, enforcing since 2 October |
| E0 | This document and the contract amendment | none |
| E1 | The exit on a node: namespace, bridge, uplink, both rule tables, DNS and DHCP, connection log, units, `verify`; proven on the node 2 test machine; switched off | none |
| E2 | The agent plug and the client map; exit health in placement | none (switched off) |
| E3 | Log shipping to the NAS, 90-day cleanup, the "who used this address" lookup | none |
| E4 | Agents' machines use the agent plug | they start there |
| E5 | Coding machines use the agent plug, with the provider door | they move |
| E6 | Company Computer: a second NIC for the browser and shells (with the next image) | it moves |
| E7 | Line guard: counting, then the brake once the founder has seen the numbers | after the founder's yes |
| E8 | Company rules | rules work |
| E9 | The address block: switch-over per node, reverse names, info page | new address |
| E10 | Each company's own log in Interfaces | companies see it |

Each step is a small PR with an exact-head independent review and a `run-on-node.mjs changed` run on the node 2 test
machine. The coordinator merges and installs.
