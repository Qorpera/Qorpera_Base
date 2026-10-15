# Agent exit: rollout runbook

For the coordinator, who runs every step on the nodes. It switches the agent exit on, then the database side and the
observer that report each node's exit, then the node release whose creators plug machines into the exit (E2c), and
last the database side that keeps agent road machines off a node whose exit is not healthy (E2d). There is no switch:
from step 5 on every agents' machine and coding machine plugs into the exit, and from step 6 on a node without a
healthy exit takes no new Company Computer or agent's machine. So the order matters, and each step has a check that
proves it and a one-command undo. Node 1 goes first; node 2 only after node 1's check.

`X` is `/usr/local/libexec/qorpera-agent-exit/qorpera-agent-exit.sh`. Node commands run as root on the node, from a
checkout of the release head (the one that carries the exit, E2c and E2d). SQL runs as the database owner, as the
migrations do: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c '<sql>'` (the health table is readable by no API role).

## Step 0: preconditions (read-only, both nodes)

Each check changes nothing. Every one must hold on both nodes before step 1.

| Precondition | Check | Holds when |
| --- | --- | --- |
| br_netfilter loaded (the guest guard and the exit's bridge rules need it) | `cat /proc/sys/net/bridge/bridge-nf-call-iptables` | `1` |
| ufw off (its forward DROP would cut the agents' bridge) | `grep '^ENABLED=' /etc/ufw/ufw.conf; ufw status` | `ENABLED=no`, `Status: inactive` |
| The guest guard is the current one and never lists `qagent0` | `/usr/local/libexec/qorpera-guest-guard/qorpera-guest-guard.sh check; grep -c qagent0 /usr/local/libexec/qorpera-guest-guard/qorpera-guest-guard.sh` | `check` exits 0 or 2 (an unguarded bridge) with no `MISMATCH bridge qagent0` line; the count is not 0 (an older guard predates the exit and must be reinstalled from the release head first: `bash deploy/guest-guard/install-guest-guard.sh`, then `systemctl restart qorpera-guest-guard.service`) |
| LXD running | `snap services lxd; lxc version` | `lxd.daemon` active, a server version printed |
| Nothing of the exit there yet | `ip netns list; ip -br link show qagent0; nft list tables \| grep qorpera_agent_exit` | no `qexit`, `Device "qagent0" does not exist`, no table |
| Address ranges free | `ip -br addr \| grep -E '10\.210\.\|10\.209\.255\.'` | nothing |
| The packages | `dpkg -s dnsmasq-base conntrack python3 2>&1 \| grep -E '^(Package\|Status)'` | either installed, or step 1 installs them (none starts a service of its own) |
| The group does not exist yet, or is a system group | `getent group qorpera-agent-plug` | nothing, or a gid below 1000 |
| The node's connection table | `cat /proc/sys/net/netfilter/nf_conntrack_max` | 262144 (as read on 2 October) |
| Room on the root disk for the exit's logs (in `/var/log/qorpera-agent-exit`, at most 2 GiB; the exit turns unhealthy with less than 10% of the disk free) | `df --output=size,avail,pcent /` | under 85% used (node 2 read 83% on 4 October; at 85% the logs keep only today, at 90% the exit is unhealthy) |
| The NAS share for the exit's logs (E3; once, for both nodes: `README.md`, "The share"): `qorpera-agent-exit-logs` on volume 1, NFS rules for 192.168.1.27 and 192.168.1.42 only, each read/write, Squash "No mapping", security `sys`, "Enable asynchronous" off | in DSM, Control Panel → Shared Folder → `qorpera-agent-exit-logs` → Edit → NFS Permissions | the two rules as listed, and no other host (step 1's mount proves the share from each node) |
| No agents' or coding machines from before (the new executor refuses to stop or delete one that is not on `qagent0`) | `lxc list --project machines --format csv -c n; lxc list --project coding --format csv -c n` (the projects the machine and coding VM policies name; these are their defaults) | nothing (or `Project not found`): production's companies were wiped on 3 October |
| The machine and coding projects allow the agent card: a bridged NIC whose parent is `qagent0`, not a network. LXD refuses it in a restricted project unless the project allows every NIC and its network list is empty or names `qagent0` (`lxd/project/permissions.go`), and only at the create; no gate checks it before | `for p in machines coding; do echo "$p: $(lxc project get $p restricted) $(lxc project get $p restricted.devices.nic) [$(lxc project get $p restricted.networks.access)]"; done` | `restricted` empty or false (`false`, `0`, `no`, `off`), or `allow` with `[]` or a list naming `qagent0` (or `Project not found`; `deploy/machine/README.md` makes `machines` unrestricted). Both nodes' `coding` read `true managed []` on 8 October: run `lxc project set coding restricted.devices.nic=allow` (this row alone may wait until right before step 5, the first create with the card). No policy digests these projects' config |

## Step 1: the exit on node 1

A node that already runs the exit from an earlier release takes E3 alone instead: `README.md`, "Adding E3 to a node
that runs the exit" (its steps, check and undo). One that runs E3 already takes E7 alone: "Adding E7 to a node that
runs the exit", and one that runs E7 takes E8b alone: "Adding E8b to a node that runs the exit", then E8b-2 (step 9).
One that runs E8b takes step 9 alone, and one that runs E8b-2 takes step 10 alone. A fresh node gets E7 with this
step, its brake off (step 4c), the rules reader, off until its login is placed (step 8), and the names reconciler of
E8b-2 and E8c-1, which gives each company with rules its own resolver once the reader runs and holds a company in
"only listed" mode to its list (step 10 says when that company's resolver restarts).

First the NAS for the logs (E3): the mount unit of `README.md`, "The mount", written to
`/etc/systemd/system/srv-qorpera-agent\x2dexit\x2dlogs.mount`, then:

```bash
apt-get install -y --no-install-recommends nfs-common
systemctl daemon-reload && systemctl enable --now 'srv-qorpera-agent\x2dexit\x2dlogs.mount'
findmnt /srv/qorpera/agent-exit-logs
# The share's marker (the shipper writes only into a mount point that holds it); there already on the second node.
# Only on the mounted share: a mount that failed leaves the bare folder, which must never get one.
mountpoint -q /srv/qorpera/agent-exit-logs &&
	{ test -e /srv/qorpera/agent-exit-logs/.qorpera-agent-exit-logs || touch /srv/qorpera/agent-exit-logs/.qorpera-agent-exit-logs; }
grep -q '^QORPERA_AGENT_EXIT_NAS_DIR=' /etc/default/qorpera-agent-exit 2>/dev/null ||
	echo 'QORPERA_AGENT_EXIT_NAS_DIR=/srv/qorpera/agent-exit-logs' >>/etc/default/qorpera-agent-exit
```

`findmnt` shows `192.168.1.40:/volume1/qorpera-agent-exit-logs` with `nfs4` and `soft`, and
`ls -A /srv/qorpera/agent-exit-logs` lists `.qorpera-agent-exit-logs`. If `findmnt` shows nothing, stop and fix the mount
first. `/etc/default/qorpera-agent-exit` is root's, mode 0644. Then the exit:

```bash
apt-get install -y --no-install-recommends dnsmasq-base conntrack python3
getent group qorpera-agent-plug || groupadd --system qorpera-agent-plug
# The rules reader's package, from the checkout with its dependencies installed (npm ci --ignore-scripts); a new folder.
node scripts/package-agent-exit-rules.mjs --out /tmp/agent-exit-rules
bash deploy/agent-exit/install-agent-exit.sh /tmp/agent-exit-rules
systemctl enable --now qorpera-agent-exit.service qorpera-agent-exit-dns.service qorpera-agent-exit-log.service \
	qorpera-agent-plug.service qorpera-agent-exit-names.service qorpera-agent-exit-health.timer \
	qorpera-agent-exit-logs.timer qorpera-agent-exit-ship.timer
systemctl start qorpera-agent-exit-logs.service qorpera-agent-exit-ship.service
```

The logs' and the shipper's timers are part of the exit, not optional: one keeps the exit's logs within their cap on
the node's root disk (`README.md`, "The logs on the node"), the other gets them onto the NAS ("The logs on the NAS"),
and `verify` fails without either. The tender's and the shipper's first passes run at once (the tender's timer may
start its own up to 30 seconds late, the shipper's a minute after the start), so `verify` need not wait for them.

Until the node's rules reader runs, `verify` fails with two `names:` lines (E8b-2): no rules file yet, and the rules
reader not running. A machine would have no DNS, so the node takes none before then: the reader's login (step 8) comes
right after step 2, for both nodes in one go, and the checks below that say healthy are read after it.

Check, within 30 seconds:
- `X verify` prints two lines and no other: `qorpera-agent-exit: not healthy: names: the rules reader is not running
  (no status)` and `qorpera-agent-exit: not healthy: names: no rules file yet: …`; after step 8 it prints
  `qorpera-agent-exit: healthy`;
- `cat /run/qorpera-agent-exit/logs.json` shows `"problems":[]`, a `capBytes` of 2147483648 and the disk's
  `freePercent`;
- `cat /run/qorpera-agent-exit/ship.json` shows `"problems":[]` and `"errors":[]`, and
  `cat /srv/qorpera/agent-exit-logs/$(hostname)/status.json` shows this node's `host` and a `through` of the pass;
- `cat /run/qorpera-agent-exit/health.json` shows a `checkedAt` under 20 seconds old (the check runs every 10 seconds),
  and `"healthy": true` after step 8;
- `X status` lists `br0 10.210.0.1/16` and `up0 10.209.255.2/30`, no ports on `qagent0` and an empty client map;
- `/usr/local/libexec/qorpera-guest-guard/qorpera-guest-guard.sh verify` still exits 0 (the guard and the exit
  coexist).

Undo (nothing is plugged in yet):

```bash
systemctl disable --now qorpera-agent-exit-health.timer qorpera-agent-exit-logs.timer qorpera-agent-exit-ship.timer qorpera-agent-exit.service && systemctl disable qorpera-agent-exit-dns.service qorpera-agent-exit-log.service qorpera-agent-plug.service qorpera-agent-exit-names.service
```

The exit's stop stops its name, log, plug and names units and the companies' resolvers itself.

The mount and the `QORPERA_AGENT_EXIT_NAS_DIR` line may stay: nothing writes to the NAS without the shipper, and what
is there stays.

## Step 2: the exit on node 2

The same as step 1, on node 2, with the same checks and the same undo. The share's marker is there already (step 1).
Then step 8 at once (the readers' login, both nodes), before step 3.

## Step 3: migration 20260930089000 (inert)

Apply the first E2d migration (the exit's health table, `qorpera_observe_runtime_node_agent_exit` and
`qorpera_runtime_node_agent_exit_ready`). It changes nothing in placement.

Check:

```sql
select to_regprocedure('public.qorpera_observe_runtime_node_agent_exit(jsonb)') is not null,
	to_regprocedure('public.qorpera_runtime_node_agent_exit_ready(uuid)') is not null,
	position('NODE_AGENT_EXIT_UNHEALTHY' in pg_get_functiondef(
		'public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)'::regprocedure)) = 0;
```

All three `true`: the health side is there, and nothing refuses yet.

Undo (only before step 6: part 2's functions call `qorpera_runtime_node_agent_exit_ready`):

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -c 'drop function public.qorpera_runtime_node_agent_exit_ready(uuid), public.qorpera_observe_runtime_node_agent_exit(jsonb), public.qorpera_assert_runtime_node_agent_exit(jsonb); drop table public.qorpera_runtime_node_agent_exit;'
```

## Step 4: the node observer that posts the exit's health, node 1 then node 2

The runtime observer is `qorpera-native25-phql-observer.service`. A cut rolls it with a new observer file next to the
running one and one more systemd drop-in that points `ExecStart` at it; the running file stays untouched for the undo
(as for `observer-nodeNN-v145.cjs` and `zzzzzzzz-observer-v145-a1.conf` on 28 September). The installer of
`deploy/first-node/NODE-OBSERVER-INSTALLATION.md` makes a first installation only and is not used here. Below, `NN` is
`01` or `02` and `v173` the release.

Build once, from a checkout of the release head with its dependencies installed (`npm ci --ignore-scripts`), and point the build at the
nodes' own configuration and key (the same two paths the running v145 files read on both nodes):

```bash
node scripts/package-runtime-node-observer.mjs --out /tmp/observer-v173
sed -e 's#/etc/qorpera/node-observer.json#/etc/qorpera-native25-phql-a1/node-observer-v26.json#g' \
	-e 's#/etc/qorpera/node-observer.key#/etc/qorpera-native25-phql-a1/node-observer.key#g' \
	/tmp/observer-v173/qorpera-node-observer.cjs > /tmp/observer-v173/observer-v173.cjs
grep -c '/etc/qorpera/node-observer' /tmp/observer-v173/observer-v173.cjs
grep -o '/etc/qorpera-native25-phql-a1/[A-Za-z0-9._-]*' /tmp/observer-v173/observer-v173.cjs | sort -u
```

The first `grep` prints `0`; the second prints exactly `node-observer-v26.json` and `node-observer.key` under
`/etc/qorpera-native25-phql-a1/`, as `grep` does on `observer-nodeNN-v145.cjs`.

Then on node 1 (root), with the file copied to the node:

```bash
install -o root -g root -m 0444 observer-v173.cjs /opt/qorpera-native25-phql-a1/observer-nodeNN-v173.cjs
cat > /etc/systemd/system/qorpera-native25-phql-observer.service.d/zzzzzzzzz-observer-v173-a1.conf <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent LANG=C LC_ALL=C /usr/bin/node --jitless /opt/qorpera-native25-phql-a1/observer-nodeNN-v173.cjs
EOF
systemctl daemon-reload && systemctl restart qorpera-native25-phql-observer.service
```

The drop-in's name has nine `z`s, so it sorts after every drop-in there (the last is `zzzzzzzz-observer-v145-a1.conf`;
if a later cut added one, use one more `z` than it has, here and in the undo) and its `ExecStart` wins. Then node 2,
the same way.

The new observer's loop reads `/run/qorpera-agent-exit/health.json` every 5 seconds and posts it on a connection of its
own; the inventory and node health loops are unchanged. The unit has no file sandbox, and the exit writes the file
root-owned 0644 in a 0755 directory, so the observer's account reads it.

Check, per node, within 30 seconds of the restart:
- `systemctl show -p ExecStart qorpera-native25-phql-observer.service` names `observer-nodeNN-v173.cjs`;
- `journalctl -u qorpera-native25-phql-observer --since -2min -o cat | grep node_agent_exit | tail -1` shows
  `{"event":"node_agent_exit","state":"healthy"}` (and `node_inventory` still `ready`);
- `select healthy, problem_count, now() - observed_at as age, now() - checked_at as check_age from public.qorpera_runtime_node_agent_exit where node_id = '<node id>';`
  shows `true`, `0` and both ages under 20 seconds (the observer posts every 5 seconds, the exit checks every 10);
- `select public.qorpera_runtime_node_agent_exit_ready('<node id>');` is `true`.

Undo (back to the untouched `observer-nodeNN-v145.cjs`; nothing reads the health yet):

```bash
rm /etc/systemd/system/qorpera-native25-phql-observer.service.d/zzzzzzzzz-observer-v173-a1.conf && systemctl daemon-reload && systemctl restart qorpera-native25-phql-observer.service
```

## Step 4b (optional): the line guard's counts

Nothing to install: from step 1 on, the logs' timer counts each closed day per company (two hours after it ends, UTC)
into `/var/log/qorpera-agent-exit/counts-YYYY-MM-DD.json`. The two weeks of counting before the brake (§8 of
`deploy/first-node/RUNTIME-AGENT-EXIT.md`) start here. To read them on a node:

```bash
/usr/local/libexec/qorpera-agent-exit/qorpera-agent-exit.sh counts --from <first day>
```

It prints, per company, the days with traffic, new connections (all and the busiest day), the most machines on a day,
the most new connections in 10 seconds (the company's and one machine's), refused, unanswered, the most failed
destinations in one minute, and (from step 4c on) the times braked and the new connections the brake dropped. Check:
after the first closed day, `ls /var/log/qorpera-agent-exit/counts-*.json` lists it. Undo: none needed (reading
changes nothing).

## Step 4c (later): the brake's levels

Only once the founder has read the counts (step 4b, two weeks) and decided the levels, well above normal use. Until
then the brake is installed and off: `/run/qorpera-agent-exit/brake.json` shows `"on": false` and `"problems": []`.
On node 1 (root), with the founder's numbers (`README.md`, "The brake": any of the four lines may be left out; with
neither of the first two the brake stays off):

```bash
cat >>/etc/default/qorpera-agent-exit <<'EOF'
QORPERA_AGENT_EXIT_BRAKE_NEW_10S=<N>
QORPERA_AGENT_EXIT_BRAKE_FAILED_60S=<F>
QORPERA_AGENT_EXIT_BRAKE_SLOW_10S=<S, under N>
QORPERA_AGENT_EXIT_BRAKE_MINUTES=<M>
EOF
systemctl restart qorpera-agent-exit-log.service
```

The logger reads the levels when it starts; its few seconds down are marked in the log, and traffic goes on.

Check, within 10 seconds: `cat /run/qorpera-agent-exit/brake.json` shows `"on": true`, the levels as written and
`"problems": []`; `X verify` prints `qorpera-agent-exit: healthy`;
`ip netns exec qexit nft list chain inet qorpera_agent_exit share` shows one rule, with `comment "slow S"`. A line that is not well formed shows in `problems`, and `verify` fails until it is fixed (the brake stays
off meanwhile). Then node 2, the same way.

Undo: remove the four lines, then `systemctl restart qorpera-agent-exit-log.service`. Running brakes end at once, each
with an `unbraked` line in the connection log.

## Step 5: the node release of the release head, node 1 then node 2

Only when step 4's last check is `true` for both nodes. Roll the release head's node release onto node 1 (the
coordinator's node release path), then node 2. It carries:
- the Company Computer workers and the LXD provider that know the new refusal `NODE_AGENT_EXIT_UNHEALTHY` and wait on
  it as for room. They must run before step 6 emits it (binaries first, then the SQL, as 20260928309700 set);
- the coding executor (E2c), whose machines plug into the exit. Its unit joins the group `qorpera-agent-plug` (it fails
  to start if the group is missing: steps 1 and 2 made it) and may write the exit's client map.

In the same step its policies move to `qagent0` (the executor refuses any other network): the machine policy
(`node scripts/machine-provider-policy.mjs … machines <pool> qagent0`, whose printed SQL enrolls the new provider
policy), and the coding VM policy (the executor configuration's `vmPolicy.network: "qagent0"` and the same policy
through `qorpera_configure_coding_vm_policy`). There are no machines from before (production's companies were wiped
on 3 October).

Check, per node:
- `systemctl is-active qorpera-coding-executor` is `active`, and its log shows no `INVALID_CODING_MACHINE_BINDING`
  or `INVALID_COMPANY_MACHINE_POLICY`;
- start a disposable agents' machine through the product (or wait for the next one): within a minute `X status`
  shows one entry in the client map and a port on `qagent0`, `X verify` stays healthy, and the machine reaches a
  website (`curl -sI https://example.com` from it) while `nc -zw2 192.168.1.40 2049` from it is refused;
- `tail -1 /var/log/qorpera-agent-exit/clients-$(date -u +%F).jsonl` shows its `plugged` line with its company.

Undo: roll the node back to its previous release (the node release path, one command). The policies may stay on
`qagent0`: the previous executor cannot make a machine on it (it is no LXD network), so nothing is made until the next
release, and there are no machines to keep. Plugged machines keep their entries until they are deleted; the exit stays
up while any is in the client map.

## Step 6: migration 20260930089100 (placement)

Only after step 5 on both nodes. Apply the second E2d migration: from now on a node whose exit is not healthy takes no
new Company Computer or agent's machine (refusal `NODE_AGENT_EXIT_UNHEALTHY`), and no new coding machine is placed
there. The migration refuses to apply (`55000`) while any enabled node with Company Computers, agents' machines or
coding machines has no healthy, current exit.

Check:

```sql
select position('NODE_AGENT_EXIT_UNHEALTHY' in pg_get_functiondef(
	'public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)'::regprocedure)) > 0,
	(select count(*) from public.qorpera_runtime_nodes n where n.enabled and public.qorpera_runtime_node_agent_exit_ready(n.id)),
	(select count(*) from jsonb_array_elements(public.qorpera_runtime_node_placement_candidates('office')) c where (c ->> 'eligible')::boolean);
```

`true`, then the number of enabled nodes (2), then the nodes the Company Computer fleet may use, as before step 6.

Undo (restores the four functions' text from before the patch, exactly; `scripts/test-agent-exit-placement-undo.mjs`
proves it):

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f deploy/agent-exit/undo-20260930089100.sql
```

The demand's refusal list keeps `NODE_AGENT_EXIT_UNHEALTHY`; nothing writes it once the patch is gone.

## After the rollout

- The exit's own log: `/var/log/qorpera-agent-exit/flows-*.jsonl` and `clients-*.jsonl` (E3 ships them to the NAS).
- A node's exit health is in its observer's journal (`node_agent_exit`) and in
  `qorpera_runtime_node_agent_exit_ready`. No operator view reads it yet; that comes with a later step.
- A node whose exit turns unhealthy keeps its running machines; new ones go to the other node. A sleeping agent's
  machine that wakes there is refused (`NODE_AGENT_EXIT_UNHEALTHY`) and moves to the other node. One tied to its
  repository's node, a Company Computer and a coding machine wake there, without internet while the exit is down. A node
  whose observer stopped reads as unobserved first (`NODE_OBSERVATION_UNAVAILABLE`), so its sleeping machines get the
  usual grace before they move. When no node has a healthy exit, a new agent's machine waits as for room (no
  candidate is left). Repair: `systemctl reload qorpera-agent-exit.service` (`README.md`, "Health and failure").
- The Company Computer's second card comes with E6 and the next office image (step 7); until then its browser keeps
  its own network.
- "Only listed" (E8c-1): when a company switches mode or narrows its list, its resolver restarts (about a second
  without names) and, unless it is now "open", its machines' connections end. A wider list only reloads it. The
  exit's reload empties the only-listed sets: until a machine asks for a name again, its new connections to that
  name's address are refused.

## Step 7 (E6): the Company Computer's agent card, with the next office image

E6 is two PRs that merge together: #925 (the office provider) and #926 (the office image). They go out with the next
office image (#411's), node 1 then node 2, after steps 1–6. Per node:
1. The exit is healthy (`X verify`). Both office units join the group `qorpera-agent-plug` and fail to start without it.
2. The offices project allows the agent card, as step 0 asks of the machine and coding projects. `P` is the project
   the office policy names (`guest.project`; no node has a project called `offices`). LXD enforces a project's
   restrictions unless `lxc project get P restricted` is empty or false (`false`, `0`, `no`, `off`). If it does, set
   `lxc project set P restricted.devices.nic=allow` (the card names a parent, `qagent0`, not a network, which
   `managed` refuses), and if `lxc project get P restricted.networks.access` lists networks, add `qagent0` to the
   list. The office gate refuses a project that would refuse the card
   (`LXD_OFFICE_INFRASTRUCTURE_UNCONFIRMED`), before any create is claimed. The project's config is in the office
   policy's digest: re-enrol the policy after.
3. The new office image. Its network configures the first card (`enp5s0`) only; the plug, which the image names
   `qagent` by its MAC, never gets DHCP.
4. The node release with the new office provider (`install-lxd-provider-host.sh`) and fleet units. The installer
   refuses an installed unit that differs and never replaces it: stop the office services and remove their installed
   units first.

A Company Computer made before has one card and the guest check refuses it (`LXD_OFFICE_GUEST_DRIFTED`); delete it
(production's companies were wiped on 3 October).

Check, per node, on a new Company Computer (or the next reset):
- within a minute `X status` shows its `office` entry in the client map and a port on `qagent0`, and `X verify` stays
  healthy; `tail -1 /var/log/qorpera-agent-exit/clients-$(date -u +%F).jsonl` shows its `plugged` line;
- in the computer, `ip -4 -o addr show qagent` shows one `10.210.*/16` address, `ip rule` shows the rules 1000–1002,
  and a shell's `/etc/resolv.conf` names `10.210.0.1` only.

Undo: roll the node back to its previous release and office image. A plugged Company Computer keeps its entry until it
is deleted.

## Step 8 (E8b): the rules reader's login

After steps 1 and 2 (both nodes have the reader installed, off) and migration 20260930230000 (E8a: the role
`qorpera_agent_exit` and `public.qorpera_agent_exit_network_rules`). It comes right after steps 1 and 2, before step 3:
the names reconciler (E8b-2) reads the reader's rules, and a node's `verify` fails until its reader runs (step 4's
observer would post the node unhealthy, and after step 6 the node would take no machine). On the Mac, from a checkout
of what the nodes run:

```bash
python3 deploy/agent-exit/rules-reader-login.py --check
python3 deploy/agent-exit/rules-reader-login.py
```

The script makes the login, places it on both nodes as a root-only file and starts both readers, in one go; it prints
only file names, sizes, a hash comparison and `ok`, never the login (`README.md`, "The rules reader (E8b)", says how
the login travels). A failed step stops it with what failed; run it again (each run makes a new login).

Check, per node:
- the script's last line is `ok`;
- `systemctl is-active qorpera-agent-exit-rules.service` is `active`;
- `cat /run/qorpera-agent-exit-rules/status.json` shows `"ok":true` and a `readAt` under 10 seconds old;
- `X verify` prints `qorpera-agent-exit: healthy` within 10 seconds (on a node that ran the exit before step 1, after
  step 9), and steps 1 and 2's checks that wait for this one hold.

Undo: on each node `systemctl disable --now qorpera-agent-exit-rules.service && rm /etc/qorpera-agent-exit/database-url`,
then as the database owner `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'alter role qorpera_agent_exit with nologin password null'`.
Without the reader, `verify` fails again ("the rules reader is not running"), the rules last read staying in force.

## Step 9 (E8b-2): each company's resolver, on a node that ran the exit before step 1

A fresh node has it from step 1 (its names reconciler) and step 8 (its rules); this step is for a node that took
step 1 as "Adding E8b to a node that runs the exit" (or an earlier one). Per node, node 1 then node 2, right after
step 8 (each node's reader runs: `"ok":true` and a fresh `readAt`; without it every machine on the node loses its
DNS). As root, from the checkout of steps 1 and 8 with the reader's package built, in one go (`README.md`, "Adding
E8b-2 to a node that runs the exit", says why this order):

```bash
bash deploy/agent-exit/install-agent-exit.sh /tmp/agent-exit-rules
systemctl enable --now qorpera-agent-exit-names.service
systemctl restart qorpera-agent-exit-log.service
systemctl reload qorpera-agent-exit.service
systemctl restart qorpera-agent-plug.service
```

From a release with E8c-1 this brings it too: the reload's rules send each machine on by the map `reach`, so a company
in "only listed" mode reaches its listed names only, over TCP 443 (README.md, "Where a company's machines may go").

Check, within 30 seconds:
- `X verify` prints `qorpera-agent-exit: healthy`;
- `cat /run/qorpera-agent-exit/names.json` shows `"problems": []`, a resolver (port) for each plugged company with
  rules and each verified machine in `mapped` (its company's port, or 53 for a company without rules);
- `systemctl list-units 'qorpera-agent-exit-resolver@*'` lists those resolvers `active`;
- `X status` lists the exit's map `dns_port` with the same addresses and ports;
- with E8c-1, `ip netns exec qexit nft list map inet qorpera_agent_exit reach` has an element for each verified machine.

Undo: from a checkout of the previous release, `install-agent-exit.sh` with its reader package, then
`systemctl reload qorpera-agent-exit.service`, `systemctl disable --now qorpera-agent-exit-names.service`,
`systemctl stop 'qorpera-agent-exit-resolver@*.service'`,
`rm -f /run/qorpera-agent-exit/names/*.mode /run/qorpera-agent-exit/names/*.owed` (E8c-1's; so a later step 9
restarts the "only listed" resolvers again) and
`systemctl restart qorpera-agent-plug.service qorpera-agent-exit-log.service`: every machine's DNS goes to the main
dnsmasq again, and every machine goes out as before.

## Step 10 (E8c-1): "only listed" by address, on a node that runs E8b-2

For a node that took step 9 from a release before E8c-1; one that takes step 9 from a release with E8c-1 has it
already. Per node, node 1 then node 2. Only while the node's rules reader runs (`"ok":true` and a fresh `readAt`):
without rules a machine reaches nothing outside. No kernel module is loaded. As root, from the checkout of the release
head with the reader's package built, in one go (`README.md`, "Adding E8c-1 to a node that runs the exit"):

```bash
bash deploy/agent-exit/install-agent-exit.sh /tmp/agent-exit-rules
systemctl restart qorpera-agent-exit-names.service qorpera-agent-exit-log.service
systemctl reload qorpera-agent-exit.service
systemctl restart qorpera-agent-plug.service
```

What the companies see:
- a company in "only listed" mode has its resolver restarted once, when the names reconciler restarts: about a second
  in which its machines get no names, and from then on every name not listed is "no such name". Once the reload is
  done its machines' connections end, and they reach the addresses of their listed names over TCP 443 only;
- later, the same restart (about a second without names) happens whenever a company switches mode either way, or
  narrows its "only listed" list. Its machines' connections end too, unless it switched to "open". A wider list only
  reloads the resolver, with no gap and no connection ended;
- every later reload of the exit (`systemctl reload qorpera-agent-exit.service`, `up`) empties the only-listed sets: a
  machine's new connections to a listed name's address are refused until it asks for that name again (the reconciler
  reloads the resolvers, which empties their caches, within seconds);
- companies in "open" mode and without rules see nothing new.

Check, within 30 seconds:
- `X verify` prints `qorpera-agent-exit: healthy`;
- `cat /run/qorpera-agent-exit/names.json` shows `"problems": []`;
- `ip netns exec qexit nft list map inet qorpera_agent_exit reach` has an element for each verified machine: `goto
  open`, or `goto only_<port>` for a company in "only listed" mode (its port in `names.json`'s `resolvers`);
- for each such company, `cat /run/qorpera-agent-exit/names/<port>.mode` says `only-listed` and no `<port>.owed` is
  left in that folder.

Undo: from a checkout of the previous release, `install-agent-exit.sh` with its reader package, then
`systemctl reload qorpera-agent-exit.service` (its rules let every machine out as before),
`systemctl restart qorpera-agent-exit-names.service`,
`rm -f /run/qorpera-agent-exit/names/*.mode /run/qorpera-agent-exit/names/*.owed` (so a later step 10 restarts the
"only listed" resolvers again), `systemctl stop 'qorpera-agent-exit-resolver@*.service'` (the names reconciler starts
each again on its port, as the previous release runs it) and
`systemctl restart qorpera-agent-plug.service qorpera-agent-exit-log.service`. An "only listed" company then has its
block list enforced and every other name answered again.

## Step 11 (E8c-2): the server name check's code, on a node that runs E8c-1

For a node that took step 10 from a release before E8c-2; one that takes step 10 from a release with E8c-2 has it
already. Per node, node 1 then node 2. It loads no kernel module and changes nothing the companies see: without the
queue modules (`nft_queue` and `nfnetlink_queue`) the server name checker does not start, the exit loads no `sni` chain,
and "only listed" goes by address alone, as with E8c-1. As root, from the checkout of the release head with the
reader's package built, in one go (`README.md`, "Adding E8c-2 to a node that runs the exit"):

```bash
bash deploy/agent-exit/install-agent-exit.sh /tmp/agent-exit-rules
systemctl restart qorpera-agent-exit-names.service qorpera-agent-exit-log.service
systemctl reload qorpera-agent-exit.service
systemctl restart qorpera-agent-plug.service
```

Check, within 30 seconds:
- `X verify` prints `qorpera-agent-exit: healthy`, and `X check` ends with `only listed by address alone (no queue
  modules)`;
- `systemctl is-active qorpera-agent-exit-sni.service` says `inactive`, and `ip netns exec qexit nft list chain inet
  qorpera_agent_exit sni` finds no such chain;
- step 10's checks.

Undo: from a checkout of the previous release, `install-agent-exit.sh` with its reader package, then
`systemctl reload qorpera-agent-exit.service` and
`systemctl restart qorpera-agent-exit-names.service qorpera-agent-plug.service qorpera-agent-exit-log.service`. The
checker's unit and files stay, unused.

## Step 12 (E8c-2): the queue modules, only with Jonas's yes

Only once Jonas has said yes to loading `nft_queue` and `nfnetlink_queue` on the nodes. Until then E8c stops at step
11: "only listed" is the allowlist by address alone. Per node, after step 11, node 1 then node 2, as root:

```bash
printf '%s\n' nft_queue nfnetlink_queue >/etc/modules-load.d/qorpera-agent-exit-sni.conf
modprobe nft_queue
modprobe nfnetlink_queue
X check
systemctl reload qorpera-agent-exit.service
```

`X check` must end with `server names checked` before the reload. The file loads both modules at every boot, before
the exit starts; without it a node that boots again goes back to the allowlist by address alone, and `X verify` does
not say so.

What the companies see:
- a company in "only listed" mode: each new TCP 443 connection of its machines to a listed name's address goes on only
  when the machine's first TLS message (its ClientHello) names a listed name, or a name under one that is not blocked.
  Any other is reset and logged as `name_not_listed`: another name, no name, no TLS, a ClientHello over 16 KiB, or one
  not whole within 5 seconds. Its connections made before the reload were checked by address only: those made since
  step 11 are marked as not yet judged, and are reset at the machine's next data (the checker never saw their start);
  older ones go on;
- while the checker restarts (about a second; it always comes back) a new connection of an "only listed" machine
  waits (the kernel drops its packets and the machine sends them again), and one being checked then is reset; none is
  let through unchecked. A connection already checked goes on;
- companies in "open" mode and without rules see nothing new.

Check, within 30 seconds:
- `X verify` prints `qorpera-agent-exit: healthy` (with the modules it also checks the `sni` chain, the checker on queue
  0 and its status file);
- `systemctl is-active qorpera-agent-exit-sni.service` says `active`, and `ip netns exec qexit nft list chain inet
  qorpera_agent_exit sni` shows the chain.

Undo: step 11's undo (the previous release has no `sni` chain), then
`systemctl stop qorpera-agent-exit-sni.service`,
`rm /etc/modules-load.d/qorpera-agent-exit-sni.conf` and `modprobe -r nft_queue nfnetlink_queue`. An "only listed"
company then goes by address alone again; step 11 again leaves it so.
