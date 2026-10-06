# Agent exit (E1, E2, E3 and E7)

The exit that agent road machines' internet traffic leaves through, one per node, the same on every node. Design and
decisions: `deploy/first-node/RUNTIME-AGENT-EXIT.md` and the contract's "2026-10-03 amendment: agent traffic leaves
through the agent exit". E1 built the exit itself. E2 adds the node's side of the agent plug: the plug tool machine
creators call, its reconciler, the bridge rules that tie each port to its MAC and each MAC to its address, `notrack`
for the bridged leg, and the health file the node observer reads. The logs' tender keeps the exit's logs on the node
small and safe for its disk, and counts each day per company for the line guard (below). E3 ships the logs to the
NAS, keeps them 90 days there, and answers "who used this address at that time" across the nodes. E7's brake slows a
company's new connections past the founder's levels, and is off until they are set. Nothing is plugged in until
the creators call `plug` (E2c); with no users and no legacy machines (founder decision, 3 October) there are no
switches and nothing to migrate. Nothing is installed in production before a milestone release.

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
| `qorpera-agent-exit.nft` | rules inside `qexit` (`inet qorpera_agent_exit`): our own networks and TCP port 25 refused at once; IPv6, invalid packets and sources outside 10.210.0.0/16 dropped; at most 16,384 open connections per machine and 98,304 in all (decided 3 October; per address, and the bridge rules pin each machine to one); a closed agent TCP connection held 30 s, not 120 (`ct timeout agent_tcp`); plain DNS to any resolver redirected to the exit; new connections and refusals counted per machine (`new_by_client`, `refused_by_client`); refused flows kept an hour for the log (`refused_flows`, `refused_other`), each machine's share rate-limited; the brake's map, sets and chains (E7, below); masquerade out of `up0`; the exit answers DHCP, and DNS and ping from the agent range, only |
| `qorpera-agent-exit-host.nft` | the node's second line (`inet qorpera_agent_exit_host`): nothing is routed into or out of `qagent0`, and the node does not track what enters from it (`notrack`; the exit tracks and bounds it); the masqueraded leg of a closed agent TCP connection is held 30 s, not 120; `qx-up` reaches public addresses only, never port 25 or the tailnet, and nothing on the node; nothing starts a connection into `qx-up`; the uplink's addresses are refused anywhere else; phase 1's masquerade, to public addresses only |
| `qorpera-agent-exit.sh` | `check`, `up`, `down`, `dns`, `log`, `plug`, `logs`, `ship`, `verify`, `health`, `status`, `counts`, `lookup` |
| `qorpera-agent-exit-log.py` | the connection log: conntrack's start and end of each agent connection (with bytes each way), each refused flow, and a gap line whenever events were lost, a read failed or a line could not be written; one JSON line each in `/var/log/qorpera-agent-exit/flows-YYYY-MM-DD.jsonl` (mode 0640); never content. It exits when its reader watches a namespace the exit replaced, and its unit starts it in the new one. It pauses past the logs' cap or under the disk's floor (below). Its line guard is the brake (E7, below) |
| `qorpera-agent-exit-logs.py` | the logs' tool: the tender (`tend`) seals and compresses the logs, cuts `dns.log`, counts each closed day per company, keeps 90 days and the cap; the shipper (`ship`, E3) copies the sealed logs, the counts and the deletion records to the NAS, each read back and compared, and keeps 90 days there; `lookup` (E3) answers who used an address, on every node; `count` (a day's numbers, writing nothing) and `report` (the founder's table) |
| `qorpera-agent-exit-bridge.nft` | the agents' bridge's own rules (`bridge qorpera_agent_exit_bridge`, on the node): before the bridge learns a MAC, a machine's port sends only its own MAC (`ports`, from LXD), so no machine takes another's or the exit's; then only ARP (its sender fields too) and IPv4 from a MAC and address pair in the client map, and DHCP only through one rule per machine (its own MAC, from no address or its own, naming its own MAC as the client), so no machine can take, release or decline another's lease; the node takes nothing from the bridge. `up` loads it filled with the entries LXD backed and the ports it held, in one transaction; the reconciler keeps it equal to LXD |
| `qorpera-agent-plug.py` | the agent plug (below): `plug` for machine creators, `reconcile` for the plug unit, `elements`, `list` |
| `qorpera-agent-exit.service` | oneshot, ordered before LXD: `up` (it turns on IPv4 forwarding if LXD has not yet), then starts the name, log and plug units; reload repairs in place; stop is `down`, which with a machine plugged in fails and changes nothing |
| `qorpera-agent-exit-dns.service` | dnsmasq, run inside `qexit` (`NetworkNamespacePath=`) and sandboxed: static DHCP leases (10 minutes) from `/var/lib/qorpera-agent-exit/dhcp-hosts` (E2 writes one `mac,address` file per machine, readable by dnsmasq's unprivileged user, and reloads the unit after removing one), machines' own names ignored and never published, DNS forwarded to 9.9.9.9 and 1.1.1.1, every query logged to `/var/log/qorpera-agent-exit/dns.log` |
| `qorpera-agent-exit-log.service` | the connection log |
| `qorpera-agent-plug.service` | the agent plug's reconciler, as root, after LXD |
| `qorpera-agent-exit-health.service`, `.timer` | `health` every 10 seconds: `verify`'s answer as `/run/qorpera-agent-exit/health.json` (`{schema, healthy, checkedAt, problems}`, mode 0644) for the node observer, which has no capabilities and cannot run `verify` |
| `qorpera-agent-exit-logs.service`, `.timer` | `logs` every 5 minutes (nice, idle I/O) |
| `qorpera-agent-exit-ship.service`, `.timer` | `ship` every 5 minutes (nice, idle I/O); a pass that hangs on the NAS ends after 15 minutes, and the next goes on from where it stopped |
| `install-agent-exit.sh` | verifies the pins, copies the files, runs `check`; installs no package, creates no group, mounts nothing, starts and enables nothing |

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
the same instance, it gives the same answer with a new time (the machine is about to be made again: one that was seen
is not unplugged as gone, and one never seen has a new hour to appear); for another machine on the same instance it
refuses. Files get mode 0644 whatever the creator's
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
  of its last plug) is unplugged under the plug lock: quarantined for 15 minutes first, then it loses its lease (dnsmasq
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

The release that carries the exit, its creators (E2c) and its place in placement (E2d) goes on in the order of
`ROLLOUT.md`, with its preconditions, checks and undos. Its steps 1 and 2 are steps 1 to 7 here (step 3, the NAS, came
with E3; a node that already runs the exit takes E3 as in "Adding E3 to a node that runs the exit", below).

`X` below is `/usr/local/libexec/qorpera-agent-exit/qorpera-agent-exit.sh`.

1. `apt-get install --no-install-recommends dnsmasq-base conntrack python3` (and `nfs-common`, already on the nodes
   for their other NAS mounts).
2. `groupadd --system qorpera-agent-plug` (before the first `up`, which gives the client map directories to it).
3. The NAS: the share and its marker (once, for both nodes), this node's mount and its `QORPERA_AGENT_EXIT_NAS_DIR`
   line ("The logs on the NAS", below). `findmnt /srv/qorpera/agent-exit-logs` shows `192.168.1.40`, and the marker
   is there.
4. `bash deploy/agent-exit/install-agent-exit.sh` from a checkout at the merged head.
5. `systemctl enable --now qorpera-agent-exit.service qorpera-agent-exit-dns.service qorpera-agent-exit-log.service
   qorpera-agent-plug.service qorpera-agent-exit-health.timer qorpera-agent-exit-logs.timer
   qorpera-agent-exit-ship.timer`, then `systemctl start qorpera-agent-exit-ship.service` for a first pass at once (the
   logs' and the shipper's timers are not optional: one keeps the logs off the node's disk, the other gets them onto
   the NAS, and `verify` fails without either).
6. `X verify` says `healthy`; `X status` shows the addresses and an empty client map;
   `/run/qorpera-agent-exit/health.json` says `"healthy": true`; `/run/qorpera-agent-exit/logs.json` and
   `/run/qorpera-agent-exit/ship.json` name no problem, and `ship.json` no error;
   `/srv/qorpera/agent-exit-logs/$(hostname)/status.json` is there.
7. Undo, only with an empty client map (`X status`):
   `systemctl disable --now qorpera-agent-exit-health.timer qorpera-agent-exit-logs.timer qorpera-agent-exit-ship.timer
   qorpera-agent-exit.service`, then `systemctl disable qorpera-agent-exit-dns.service qorpera-agent-exit-log.service
   qorpera-agent-plug.service`. The exit's stop stops the name, log and plug units itself. Never stop those by name
   while a machine is plugged in: traffic would keep flowing without names and without the log, and nothing would
   flush or unplug machines. The mount may stay: nothing writes there without the shipper.

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
10.210.0.1:53 (from a name service in the exit's current namespace), a logger heartbeat younger than 30 seconds with
the logger neither paused nor failing to write, a brake status younger than 30 seconds with no problem (also while
the brake is off), a reconciler status younger than 30 seconds with no problem, a logs' tender status younger than 15
minutes with no problem, and a shipper status younger than 30 minutes with no problem (a NAS folder set, and no file
waiting more than 24 hours to go to the NAS) are all there. The heartbeat is
written only while both of the logger's readers are alive. A NAS that is away for less than a day does not make the
exit unhealthy: the files wait on the node (under the cap and the floor, as always) and go when it is back. Past a day,
`verify` fails until they have gone. If the exit is down, its agent road machines have no internet; nothing falls back to
the platform road. `X health` (every 10 seconds) writes the answer for the node observer; E2d keeps new agent road
machines off a node whose exit is not healthy.

`up` restarts the name service when it runs in an older namespace than the exit's (after a rebuild, also one an
earlier, interrupted `up` made); the logger notices the same by itself and exits.

## The logs on the node (E3's node half, E7's counts)

The exit's logs live in `/var/log/qorpera-agent-exit` on the node's root disk, and once sealed also on the NAS (E3,
below): the connection log (`flows-*`), the client history (`clients-*`) and the DNS record (`dns.log`). One agent connection is
about 340 bytes of connection log; a machine opening 100 connections a second would write about 3 GB a day, and a flood
far more. So `X logs` (the logs' timer, every 5 minutes) tends them:
- **Seals.** Each open file is sealed into a compressed part (`flows-YYYY-MM-DD.pNNN.jsonl.gz`, mode 0640) once its day
  is closed (two hours after it ends, UTC: the plug's `plugged` lines carry the entry's time, normally less than an
  hour back), or sooner once it holds 64 MiB. The writers open the file for each line, so a renamed file takes no new
  lines. It is renamed to its part's name first (`….pNNN.sealing`), so a pass cut short finishes that part and never
  seals a line twice.
- **Cuts the DNS record.** `dns.log` is copied into `dns-YYYY-MM-DDTHHMMSSZ.log` (then compressed) and truncated once a
  day, or sooner once it holds 64 MiB. The copy stops at what was there plus 64 MiB, however fast dnsmasq writes.
  dnsmasq appends (`O_APPEND`), so it writes on from the start; what it wrote between the copy's end and the truncate
  is lost. (Renaming it and sending SIGUSR2 would not do: dnsmasq's unprivileged user cannot create a file in the 0750
  folder.)
- **Counts, once.** Each closed day is counted once, per company, into `counts-YYYY-MM-DD.json`, as soon as all its
  files are sealed; its counts never change after. The numbers are the line guard's (`RUNTIME-AGENT-EXIT.md` §8):
  machines, new connections (by protocol), the most new connections in one 10-second step (the company's and one
  machine's), refused flows (by rule), unanswered connections, distinct failed destinations (unanswered or refused) and
  the most of them in one minute, how often the brake held the company and how many new connections it dropped (its
  `braked` and `unbraked` lines, below), and per node the gap lines. An address belongs to a company from its `plugged` line
  to its `unplugged` one. Each counts file keeps the parts it counted and who was plugged in when its day ended: the
  newest one is the checkpoint the next day starts from (`attribution.json` is a copy), and the counts file, written
  whole and then renamed, is the one commit point. A part that turns up for a day already counted (after the plug's
  reconciler was down, its `plugged` line can be days back) is counted with the next day the tender counts, under its
  own day (`late`, with its own numbers per company); the day it belongs to never changes. Traffic from an address with
  no company at that moment counts as `unattributed`, also when a late plug for it turns up afterwards. Counting never
  slows or refuses anything; the brake does, at the founder's levels (below). A closed day the tender cannot count (a part it
  cannot seal) is a problem in `logs.json`, so `verify` fails.
- **Keeps the disk safe.** 90 days are kept. A part the NAS holds (the shipper's record of it, below) goes from the
  node a week after its day, with no deletion record: the NAS has it. Past 80% of the cap, or with less than the floor
  plus 5 points of the disk free, the parts the NAS holds go first, oldest first; then the oldest of the rest: the DNS
  record's and the connection log's, then the client history's (small, and
  what ties addresses to companies). One rule for the connection log and the client history, at 90 days and under
  pressure alike: a part goes only once a counts file names it. The open files and the counts never go under
  pressure; so while a day cannot be counted, the logger's pause is what keeps the disk. At 90 days a counts file goes
  only after every part it names, and the newest one (the checkpoint) never; each pass writes `attribution.json` again
  if it is missing or behind. Each deleted file has its own record, `lost/<name>.json`, written whole (a temporary
  file, synced, renamed) before the file goes, and `lost/` and the log folder are synced before every deletion: a
  record exists complete or not at all, and a failed sync deletes nothing. Every pass first finishes the recorded
  deletions whose file is still there (their records synced first), whatever the pressure is then. So a lookup knows
  that day is unknown, and a part's name is never used twice. The records count toward the cap, for the tender and
  the logger alike, though they never go.

The cap is 2 GiB and the floor 10% of the disk unless the node sets them in `/etc/default/qorpera-agent-exit`
(`QORPERA_AGENT_EXIT_LOG_CAP_BYTES=<bytes>` and `QORPERA_AGENT_EXIT_LOG_FLOOR_PERCENT=<percent>` lines, read by the tool
for the logger and the tender alike; the logger reads them when it starts). The logger checks both every 5 seconds:
past the cap, or under the floor, it pauses. It writes no connection, refusal or alive lines (below), only a gap line
when it pauses and one when it goes on (with how many connection and refusal lines it did not write), empties
`dns.log` every 5 seconds (dnsmasq answers on; a gap line says how much of the DNS record was not kept), and keeps
`/run/qorpera-agent-exit/logger.pause` meanwhile, so `verify` fails: the node takes no new agent road machines (E2d)
while its log cannot record, and its disk never fills. Traffic and refusals go on (the log-down rule of 3 October). It
goes on under 95% of the cap and 2 points above the floor. A line it cannot write (a full disk, no inodes left; an
alive line too, so this shows also with no traffic) is counted and keeps `/run/qorpera-agent-exit/logger.failing`
until a line can be written again (it tries every 5 seconds), so `verify` fails meanwhile; the first line then
written is a gap line saying how many it lost. On a disk filled by something else, the exit turns unhealthy at the
floor: for node 2 (98 GB, 16 GB free on 4 October) that is 90% used.

While it logs (its readers alive in the exit's namespace, not paused), the logger writes an alive line into the
connection log every minute (`{"event":"alive","ts":…}`). They go to the NAS with the rest, so a lookup on any node
sees when a logger was not logging, also when no gap line says so yet (below). The counts skip them.

`X counts [--from DAY] [--to DAY] [--json]` prints the founder's table: per company, the days with traffic, connections
(all and the busiest day), the most machines on a day, the burst peaks, refused, unanswered, the most failed
destinations in a minute, the times braked and the new connections the brake dropped. `qorpera-agent-exit-logs.py count --log-dir … --day DAY` shows one day (also today) from what
is there.

## The logs on the NAS (E3)

Every 5 minutes the shipper (`X ship`, the ship timer) copies to the NAS what the tender sealed: the connection log's
and the client history's parts, the DNS record's parts, the counts and the deletion records, oldest day first. Each copy
is written beside its name, synced, renamed into place, then read back from the NAS (not from the node's cache) and
compared. Only then does the node keep a record of it (`shipped/<name>.json`, with its sha256 and where it went). A
file already on the NAS with the same content counts as shipped; one with other content is never overwritten: it stays
on the node, with an error in `ship.json`. The open files and `dns.log` go once they are sealed or cut. Each node
removes its own day folders on the NAS once they are older than 90 days.

### The share (the coordinator, once)

Jonas approved the share, with root allowed to write, on 6 October. On the Synology NAS (192.168.1.40):
- a shared folder `qorpera-agent-exit-logs` on volume 1, of its own (not in the workbench or the company data);
- its NFS rules: one for node 1 (192.168.1.27) and one for node 2 (192.168.1.42), each read/write, Squash "No
  mapping" (root writes as root: the logs are root's, mode 0640 files in 0750 folders), security `sys`, and
  "Enable asynchronous" off (the shipper syncs each file before it counts it as shipped; with it on, the NAS answers
  before the file is on its disks). No other host;
- after the first mount, its marker (an empty file), only once the share is mounted:
  `mountpoint -q /srv/qorpera/agent-exit-logs && touch /srv/qorpera/agent-exit-logs/.qorpera-agent-exit-logs`.
  The shipper writes only into a mount point that holds it, so a share that is not mounted never fills the node's own
  disk under the empty mount point (not even with a marker left there by mistake), and the lookup says the NAS is not
  mounted. A pass opens that folder once and does every step on the NAS through it, so it never writes past an
  unmount: a plain one fails while a pass runs (busy), and a lazy one leaves the pass on the share.

### The mount (each node, root)

A mount unit like the nodes' other NAS mounts, `/etc/systemd/system/srv-qorpera-agent\x2dexit\x2dlogs.mount`
(`systemd-escape -p --suffix=mount /srv/qorpera/agent-exit-logs` gives its name):

```
[Unit]
Description=Qorpera agent exit logs on the NAS (E3)
Wants=network-online.target
After=network-online.target

[Mount]
What=192.168.1.40:/volume1/qorpera-agent-exit-logs
Where=/srv/qorpera/agent-exit-logs
Type=nfs4
Options=rw,nosuid,nodev,noexec,vers=4.1,proto=tcp,soft,timeo=150,retrans=3,sec=sys,_netdev
DirectoryMode=0000
TimeoutSec=45

[Install]
WantedBy=remote-fs.target
```

then `systemctl daemon-reload && systemctl enable --now 'srv-qorpera-agent\x2dexit\x2dlogs.mount'`, and the line
`QORPERA_AGENT_EXIT_NAS_DIR=/srv/qorpera/agent-exit-logs` in `/etc/default/qorpera-agent-exit` (root's, mode 0644; an
absolute path, nothing else on the line). `soft`, unlike the other NAS mounts: a NAS that stops answering gives the
shipper and the lookup an error after a few minutes instead of hanging them. A write a soft mount loses is caught by the
read-back and tried again next pass.

### What is on the NAS

```
/srv/qorpera/agent-exit-logs/
  .qorpera-agent-exit-logs              the marker
  company41-node-01/                    one folder per node, named by its host name, written by that node only
    status.json                         the node's last pass, and the days whose lines are not all on the NAS yet
    2026-10-07/                         one folder per day (UTC)
      flows-2026-10-07.p001.jsonl.gz    the connection log's parts
      clients-2026-10-07.p001.jsonl.gz  the client history's
      dns-2026-10-07T000500Z.log.gz     the DNS record cut that day (its lines are from before the cut)
      counts-2026-10-07.json            the day's counts
      lost/<name>.json                  a deletion record: a file of this day the node deleted before it went
  company41-node-02/
```

`/run/qorpera-agent-exit/ship.json` (mode 0644) is the last pass: `shipped`, `waiting`, `oldestWaiting`,
`removedFromNas`, `errors` (the last 20) and `problems`. A pass writes it when it starts (`"shipping": true`) and every
minute while it runs. Errors do not make the exit unhealthy by themselves: the NAS not mounted (no mount point there, or
no marker in it), a file on
the NAS with other content, a copy that read back wrong, the NAS not answering, a pass that did not finish. Problems
do: no NAS folder set, or a file that has waited more than 24 hours (with the last error).

### Who used this address

From an abuse report (a site's address, maybe its port, and a time):

```
X lookup --at 2026-10-07T13:05:00Z --remote 203.0.113.9 --remote-port 443
X lookup --at 1791378300 --agent 10.210.1.17 --json
```

Every company on a node leaves from the same public address (phase 1), and both nodes may leave from the same one. So
the lookup reads this node's own logs and every node's folder on the NAS. It lists each agent connection to that
address (and port), or from that agent address, that was open within `--window` seconds (300 unless set) of `--at`
(an ISO time, UTC unless it says otherwise, or seconds since 1970): the node, start and end, the company, the machine
(its kind, and the member for a coding machine), the agent's address and port, the bytes each way, and the name the
machine had looked up for that address. Refused attempts in the window come after. It reads the days from `--days`
(1 unless set) before the window to as many after, for each connection's start or end line.

What the logs cannot say is listed as not known, never as "no one": a gap line (the logger down or paused, events
lost), a deleted file (its record), a file that should be there and is not, a node that has not shipped since before
the window or has days not on the NAS yet, the NAS not mounted, this node's logger not running, paused or unable to
write now (its heartbeat, `logger.pause` and `logger.failing`, which say since when), and time past 90 days. Also any
stretch of more than 3 minutes with no line that says the logger was logging (an alive line, or its `logger started`,
`paused: …` or `resumed: …` line, where `paused: …` is the pause itself, not `paused: … DNS record not kept`; not the
other gap lines, which a paused logger writes too), on any node, from its first day of logs to now (or, for another
node, to its last pass):
the logger was down, paused or could not write then. That covers what no line read says: a logger stopped and not
started again (on another node too, after its day went to the NAS), and an outage or pause that began before the days
read and ended after them. Each stretch is judged at its full length: one across the edge of the days read runs from
the logger's last line of the day before to its first of the day after (those two days are read for that alone), so a
stop that crosses midnight is listed in full within the days read, however little of it falls there. A stretch the
answer already lists as not known (a gap line's span, a day not on the NAS yet) is not listed again. A
`paused: … DNS record not kept` line with no pause line before
it (they come only while the logger pauses) is a pause that began before what was read. The answer is complete only
when neither connections nor companies are unknown for that time; a gap only in the DNS record leaves names unknown. A
starting logger writes `logger started` before its own pause line, so a pause that ended when the logger stopped is
told apart from one still going.

Limits:
- Another node's lines that are not sealed yet (today's, and up to two hours of yesterday's) and its `dns.log` since
  the last cut are on that node only. For recent times, run the lookup on each node; the answer says which days of
  which node it could not read ("its flows of DAY are not on the NAS yet").
- A connection whose start and end lines both lie outside the days read (open longer than `--days` on each side) is
  not found: raise `--days` for long ones.
- A connection whose end line fell in a gap shows "end not read" (and the gap is listed).
- DNS lines dnsmasq writes between a cut's copy and its truncate are lost without a gap line ("Cuts the DNS record",
  above); a name may be missing without a note. Names never decide whether an answer is complete.
- A pause counts as unknown even when its `resumed` line says no line was missed.
- A stop of under 3 minutes shows only through the gap line that ends it (`logger started`, `resumed`, `lines could
  not be written`); until that line is written, only on the node itself (its heartbeat and markers).
- A node's first day of logs is not known from 00:00 UTC to its logger's first line. On a node that ran the exit
  before E3, the time before its logger first wrote alive lines is not known either.
- dnsmasq stamps its lines in its local time; the exit runs it with `TZ=UTC`, so the names' times are UTC whatever the
  node's zone.
- A retired node's folder stays: its `status.json` keeps saying it has shipped nothing since its last pass, so answers
  for later times are not complete until its folder is moved off the share (by hand, after its 90 days).

### Adding E3 to a node that runs the exit

The tool before E3 reads only numbers from `/etc/default/qorpera-agent-exit`, so the NAS can be set up first.
1. The share and its marker (once), this node's mount and its `QORPERA_AGENT_EXIT_NAS_DIR` line (above).
2. `bash deploy/agent-exit/install-agent-exit.sh` from a checkout at the merged head, then at once
   `systemctl enable --now qorpera-agent-exit-ship.timer && systemctl start qorpera-agent-exit-ship.service`. Between
   the install and that first pass, `verify` fails ("the logs' shipper has not run"), so the health file may say
   unhealthy for a turn or two. Then `systemctl restart qorpera-agent-exit-log.service`: the new logger writes the
   alive lines, and until it runs every lookup says the connection log is not known. Its few seconds down are marked
   by its `logger started` line, and traffic goes on meanwhile. dnsmasq takes `TZ=UTC` at its next start; both nodes
   run on UTC (read on 6 October), so nothing waits on that.
3. Check: `X verify` says `healthy`; `ship.json` names no problem and no error; `$(hostname)/status.json` is on the
   NAS, and the node's sealed parts are in its day folders.
4. Undo: install the earlier release's files again (`install-agent-exit.sh` from its checkout), then
   `systemctl disable --now qorpera-agent-exit-ship.timer`. What is on the NAS stays.

## The brake (E7)

The line guard's brake (`RUNTIME-AGENT-EXIT.md` §8) is off until the founder sets its levels, after two weeks of
counts (`X counts`, above). It lives in the logger, which sees each new and each failed connection as it writes its
line, and counts them as the counts do.

The levels are lines in `/etc/default/qorpera-agent-exit` (root's, mode 0644):

| Line | What | Unset |
| --- | --- | --- |
| `QORPERA_AGENT_EXIT_BRAKE_NEW_10S=N` | a company with more than N new connections in one 10-second step (all its machines; the steps of the counts' `peak10s`) is braked | not used |
| `QORPERA_AGENT_EXIT_BRAKE_FAILED_60S=F` | a company with more than F failed destinations (unanswered or refused, each counted once) in one minute is braked | not used |
| `QORPERA_AGENT_EXIT_BRAKE_SLOW_10S=S` | while braked, the company's machines share S new connections per 10 seconds; S must be under N | 50 |
| `QORPERA_AGENT_EXIT_BRAKE_MINUTES=M` | a brake lasts M minutes (1 to 1440) from the last moment the company was past a level | 10 |

With neither N nor F set (or both 0) the brake is off. A line that is not a whole number in range, or an S not under
N, also turns it off, and `verify` fails ("the brake: …") until the line is fixed: a level that was not meant never
brakes a company. The logger reads the levels when it starts, so after a change: `systemctl restart
qorpera-agent-exit-log.service`. Its few seconds down are marked by its `logger started` line, and traffic goes on.

While a company is braked:
- Each new connection of its machines towards the internet (a connection's first packet, of any protocol) takes one of
  the company's S per 10 seconds; a new brake starts with all S. Past them the packet is dropped, as on a busy line.
  TCP sends its first packet again after 1, 3 and 7 seconds (Linux) and goes through once there is room; a UDP program
  asks again or not, as it would anywhere.
- Open connections go on untouched, and so does what goes to the exit itself (names, DHCP, ping). Refusals and the
  bounds on open connections hold as before. Other companies are not touched: each braked company has its own share.
- A dropped connection counts as a new one of its company, once however often its first packet comes again (the exit
  keeps each dropped flow 3 minutes, `tried`), and not again when a resend goes through (`resent`). So a company that
  keeps pushing stays braked, and one that slows down is let go M minutes after it was last past a level.

The guard writes a `braked` line into the connection log when a brake starts (`company`, `reason`, `until`,
`slow10s`) and an `unbraked` line when it ends (`company`, `since`, and `dropped`: the new connections it dropped that
never went through), also while the logger pauses. They go to the NAS with the rest. The day's counts carry `brakes`
and `droppedByBrake` per company, and `X counts` shows them.

How it is kept:
- Every 2 seconds (at once when a brake starts) the guard keeps the exit's rules equal to its brakes: the `braked` map
  holds each machine of a braked company with the company's number, and the `share` chain one rule with S (`slow S`)
  while the brake is on. A machine's company is the plug's own copy of its entry, and only for an entry the plug
  verified (as for the client history, above); the guard reads them again every 10 seconds.
- Each map element ends with its brake (its own timeout), so a brake ends on time also while the logger is down.
- A reload of the rules (`up`) empties the map, and the guard fills it again within 2 seconds. A logger restart keeps
  the brakes that were running (from its status file); with the levels removed, it ends them at once.
- An unplugged machine leaves the map when the guard reads the entries again (within about 12 seconds), and its
  dropped flows leave `tried` as they time out (3 minutes); its address is in quarantine for 15 minutes meanwhile. The
  plug clears its other per-machine sets at once, as before; an element that times out meanwhile is no error.
- `/run/qorpera-agent-exit/brake.json`, every 2 seconds: `on`, `levels`, `braked` (per company: its number, since,
  until, the reason, the connections dropped, its machines) and `problems`. `verify` fails when it is missing ("the
  brake not running"), older than 30 seconds, or names a problem (a bad level, rules the guard cannot read or write).
- `X status` lists the braked machines, each number's dropped connections, and `brake.json`.

### Adding E7 to a node that runs the exit

1. `bash deploy/agent-exit/install-agent-exit.sh` from a checkout at the merged head, then at once
   `systemctl reload qorpera-agent-exit.service` (the rules with the brake's map, sets and chains, in place), then
   `systemctl restart qorpera-agent-exit-log.service qorpera-agent-plug.service`. Between the install and the logger's
   restart, `verify` fails ("the brake not running"), so the health file may say unhealthy for a turn.
2. Check: `X verify` says `healthy`; `/run/qorpera-agent-exit/brake.json` shows `"on": false` and `"problems": []`.
3. The levels, only once the founder has decided them: their lines in `/etc/default/qorpera-agent-exit`, then
   `systemctl restart qorpera-agent-exit-log.service`. Check: `brake.json` shows `"on": true`, the levels as written
   and `"problems": []`, and `X verify` says `healthy`. Undo: remove the lines and restart the logger; running brakes
   end at once.
4. Undo of the install: install the earlier release's files again, then `systemctl reload qorpera-agent-exit.service`
   and `systemctl restart qorpera-agent-exit-log.service qorpera-agent-plug.service`.

## Test

`qorpera-agent-exit.test.mjs` checks the pins, the logger's parsers and pause decision, the logs' tender (a day sealed
and counted only once closed, a company carried from an earlier day, an address that changes company, parts by size, a
late part counted with the next day under its own day, a pass cut short after the counts file, a closed day that
cannot be counted, the DNS cut, a pass cut short while sealing, the report, the cap's order of deletion, the floor,
90 days), the shipper (a pass and its read-back, a file on the NAS with other content and its wait past a day, a NAS
folder that is no mount point or has no marker, a copy that reads back wrong, a shipped part's week on the node and its
turn under pressure, 90 days on the NAS), the lookup across two nodes (the company, machine and name behind a
connection, a refusal, and each kind of gap: lost events, a pause and the ways it ends, the DNS record not kept, a
pause begun before what was read, a deleted file, a node's days not shipped, a stretch with no alive line here and on
another node that stopped after it shipped, one across midnight at either edge of the days read, a paused logger's
other gap lines, which are no sign that it logged, a node whose logs begin later, a logger not running, paused or failing now, no NAS or one not mounted). The tests' NAS is a plain folder
(`--nas-any-folder`). Then the plug tool: allocation under the creators' umask, twelve plugs at once, quarantine, and the
reconciler against a stand-in for LXD (attribution only after a match, a forged claim, sleep, two misses before an unplug, a machine made again, an entry
removed by hand, plugs never created, unusable entries and links never followed, the bridge sets, the twins it finds).
Then the brake on a stand-in for the exit's rules: the levels (off until set, and any problem turns it off), the
braked map, the share chain and the counted sets as `nft -j` lists them, a company braked past either level, longer
while it goes on (its dropped connections counted once) and let go after, and a failed read or write and a restart
that keep the brake; and the counts and the report with the brake's lines.
On Linux with Docker it runs `test/proof.sh` in a privileged container with no network of its own (`ubuntu:26.04`
with the packages above, built once and cached). The proof never leaves the container's namespaces and never unloads
a kernel module (the kernel loads nftables' own on demand).
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
- the logs on the node: the day's counts per company from the live logs, the tender sealing the open files and cutting
  `dns.log` while dnsmasq and the logger write on into new ones, a line the logger cannot write (unhealthy at once,
  the lookup saying so, recovered by itself with a gap line), and the logger pausing past its cap (no lines, traffic
  and DNS on, `dns.log` emptied, `verify` failing, the lookup saying so) and going on with a gap line saying what it
  missed;
- the logs on the NAS (a tmpfs mounted in the container, with its marker): the shipper's copies, byte for byte, with their records, the
  logger's alive lines, and the lookup naming the company, machine and name behind a live connection;
- the brake, with levels in a settings file (5 new connections in 10 seconds, a share of 2, 5 minutes): a second
  company's machine past the level braked (a `braked` line, the machine in the map with its company's number), then
  of 10 new connections at once only 2 through and the rest dropped, each counted once however often resent, a
  dropped one let through on a later resend and counted in `resent`, the brake held longer, the agent machine's
  company never braked and `verify` healthy throughout; an unplug taking the machine's counts with it (destroying an
  element that is already gone is no error) and the machine out of the map for good, its company still braked; a
  restart without levels ending the brake at once (an `unbraked` line with what it dropped); and a share as large as
  its level, or a level that looks like an option, leaving the brake off and `verify` failing;
- an interrupted rebuild: the logger leaves the old namespace by itself, and `verify` fails until DNS follows;
- that `down` refuses with a machine plugged in, or only in the client map, and changes nothing; that with the
  exit's namespace gone the machine has no internet and no names; and that with nothing plugged in `down` removes
  everything while the name and log services run.

Where the kernel has br_netfilter loaded, the proof also checks that the node does not track the bridged leg; the
test machines do not load it, so it prints a SKIP line there. Not covered here: br_netfilter, LXD's own MAC and IPv6
filters and port isolation, LXD's API as the reconciler reads it, systemd's handling of the units, a real NFS mount
(the proofs' NAS is a tmpfs; the shipper reads each copy back), and running
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

- E10 (each company's own log view) reads the NAS the way the lookup does: `<host>/<day>/`, the deletion records
  under `lost/`, each node's `status.json` for what is not there yet, and the same rule that a gap is unknown, never
  "no one".
- The per-machine connection bound counts per address; the bridge rules and LXD's MAC filter pin each machine to its
  address. A reload of the rules starts both counts again from zero, and recreates the 30 s timeout policy: the
  connections open at that moment close into the kernel's 120 s. The trade-off of 30 s: a site that closed first and
  still holds TIME_WAIT (60 s on Linux, up to 240 s elsewhere) may see the same public port again and delay or refuse
  that one connection, against a quarter of the entries and shared ports held. The node's table holds 262,144 entries
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
