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
| No agents' or coding machines from before (the new executor refuses to stop or delete one that is not on `qagent0`) | `lxc list --project machines --format csv -c n; lxc list --project coding --format csv -c n` (the projects the machine and coding VM policies name; these are their defaults) | nothing (or `Project not found`): production's companies were wiped on 3 October |

## Step 1: the exit on node 1

```bash
apt-get install -y --no-install-recommends dnsmasq-base conntrack python3
getent group qorpera-agent-plug || groupadd --system qorpera-agent-plug
bash deploy/agent-exit/install-agent-exit.sh
systemctl enable --now qorpera-agent-exit.service qorpera-agent-exit-dns.service qorpera-agent-exit-log.service \
	qorpera-agent-plug.service qorpera-agent-exit-health.timer qorpera-agent-exit-logs.timer
```

The logs' timer is part of the exit, not optional: it keeps the exit's logs within their cap on the node's root disk
(`README.md`, "The logs on the node"), and `verify` fails without it.

Check, within 30 seconds:
- `X verify` prints `qorpera-agent-exit: healthy`;
- `cat /run/qorpera-agent-exit/logs.json` shows `"problems":[]`, a `capBytes` of 2147483648 and the disk's
  `freePercent`;
- `cat /run/qorpera-agent-exit/health.json` shows `"healthy": true` and a `checkedAt` under 20 seconds old (the check runs every 10 seconds);
- `X status` lists `br0 10.210.0.1/16` and `up0 10.209.255.2/30`, no ports on `qagent0` and an empty client map;
- `/usr/local/libexec/qorpera-guest-guard/qorpera-guest-guard.sh verify` still exits 0 (the guard and the exit
  coexist).

Undo (nothing is plugged in yet):

```bash
systemctl disable --now qorpera-agent-exit-health.timer qorpera-agent-exit-logs.timer qorpera-agent-exit.service && systemctl disable qorpera-agent-exit-dns.service qorpera-agent-exit-log.service qorpera-agent-plug.service
```

## Step 2: the exit on node 2

The same as step 1, on node 2, with the same checks and the same undo.

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
the most new connections in 10 seconds (the company's and one machine's), refused, unanswered, and the most failed
destinations in one minute. Check: after the first closed day, `ls /var/log/qorpera-agent-exit/counts-*.json` lists it.
Undo: none needed (reading changes nothing).

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
- The Company Computer's second card comes with E6 and the next office image; until then its browser keeps its own
  network.
