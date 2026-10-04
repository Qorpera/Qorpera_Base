# Agent exit: rollout runbook

For the coordinator, who runs every step on the nodes. It switches the agent exit on, then the creators that plug
machines into it (E2c), then the database side that keeps agent road machines off a node whose exit is not healthy
(E2d). There is no switch: from step 5 on, a node without a healthy exit takes no new Company Computer or agent's
machine, and from step 6 on every agents' machine and coding machine plugs into the exit. So the order matters, and
each step has a check that proves it and a one-command undo. Node 1 goes first; node 2 only after node 1's check.

`X` is `/usr/local/libexec/qorpera-agent-exit/qorpera-agent-exit.sh`. All commands run as root on the node, from a
checkout of the release head (the one that carries the exit, E2c and E2d).

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
| No agents' or coding machines from before (the new executor refuses to stop or delete one that is not on `qagent0`) | `lxc list --project machines --format csv -c n; lxc list --project coding --format csv -c n` | nothing (or `Project not found`): production's companies were wiped on 3 October |

## Step 1: the exit on node 1

```bash
apt-get install --no-install-recommends dnsmasq-base conntrack python3
getent group qorpera-agent-plug || groupadd --system qorpera-agent-plug
bash deploy/agent-exit/install-agent-exit.sh
systemctl enable --now qorpera-agent-exit.service qorpera-agent-exit-dns.service qorpera-agent-exit-log.service \
	qorpera-agent-plug.service qorpera-agent-exit-health.timer
```

Check, within 30 seconds:
- `X verify` prints `qorpera-agent-exit: healthy`;
- `cat /run/qorpera-agent-exit/health.json` shows `"healthy": true` and a `checkedAt` under 10 seconds old;
- `X status` lists `br0 10.210.0.1/16` and `up0 10.209.255.2/30`, no ports on `qagent0` and an empty client map;
- `/usr/local/libexec/qorpera-guest-guard/qorpera-guest-guard.sh verify` still exits 0 (the guard and the exit
  coexist).

Undo (nothing is plugged in yet):

```bash
systemctl disable --now qorpera-agent-exit-health.timer qorpera-agent-exit.service && systemctl disable qorpera-agent-exit-dns.service qorpera-agent-exit-log.service qorpera-agent-plug.service
```

## Step 2: the exit on node 2

The same as step 1, on node 2, with the same checks and the same undo.

## Step 3: migration 20260930037000 (inert)

Apply the first E2d migration (the exit's health table, `qorpera_observe_runtime_node_agent_exit` and
`qorpera_runtime_node_agent_exit_ready`). It changes nothing in placement.

Check (service role, read-only):

```sql
select to_regprocedure('public.qorpera_observe_runtime_node_agent_exit(jsonb)') is not null,
	to_regprocedure('public.qorpera_runtime_node_agent_exit_ready(uuid)') is not null,
	position('NODE_AGENT_EXIT_UNHEALTHY' in pg_get_functiondef(
		'public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)'::regprocedure)) = 0;
```

All three `true`: the health side is there, and nothing refuses yet.

Undo: `drop function public.qorpera_runtime_node_agent_exit_ready(uuid), public.qorpera_observe_runtime_node_agent_exit(jsonb), public.qorpera_assert_runtime_node_agent_exit(jsonb); drop table public.qorpera_runtime_node_agent_exit;`
(only before step 5: part 2's functions call `qorpera_runtime_node_agent_exit_ready`).

## Step 4: the node observer that posts the exit's health, node 1 then node 2

Roll the node observer of the release head onto node 1 as for any observer update (the coordinator's node release
path), then onto node 2. Its new loop reads `/run/qorpera-agent-exit/health.json` every 5 seconds and posts it on a
connection of its own; the inventory and node health loops are unchanged.

Check, per node, within 30 seconds of the observer's start:
- `journalctl -u qorpera-node-observer --since -2min -o cat | grep node_agent_exit | tail -1` shows
  `{"event":"node_agent_exit","state":"healthy"}` (and `node_inventory` still `ready`);
- service role: `select healthy, problem_count, now() - observed_at as age, now() - checked_at as check_age from public.qorpera_runtime_node_agent_exit where node_id = '<node id>';`
  shows `true`, `0` and both ages under 15 seconds;
- `select public.qorpera_runtime_node_agent_exit_ready('<node id>');` is `true`.

Undo: roll the node back to its previous observer (the same node release path). Nothing reads the health yet.

## Step 5: migration 20260930037100 (placement)

Only when step 4's last check is `true` for both nodes. Apply the second E2d migration: from now on a node whose exit
is not healthy takes no new Company Computer or agent's machine (refusal `NODE_AGENT_EXIT_UNHEALTHY`), and no new
coding machine is placed there.

Check (service role, read-only):

```sql
select position('NODE_AGENT_EXIT_UNHEALTHY' in pg_get_functiondef(
	'public.qorpera_reserve_runtime_node_machine(uuid,text,text,text,text,text,bigint,bigint)'::regprocedure)) > 0,
	(select count(*) from public.qorpera_runtime_nodes n where n.enabled and public.qorpera_runtime_node_agent_exit_ready(n.id)),
	(select count(*) from jsonb_array_elements(public.qorpera_runtime_node_placement_candidates('office')) c where (c ->> 'eligible')::boolean);
```

`true`, then the number of enabled nodes (2), then the nodes the Company Computer fleet may use, as before step 5.

Undo (restores the four functions' text from before the patch, exactly; `scripts/test-agent-exit-placement-undo.mjs`
proves it):

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f deploy/agent-exit/undo-20260930037100.sql
```

The demand's refusal list keeps `NODE_AGENT_EXIT_UNHEALTHY`; nothing writes it once the patch is gone.

## Step 6: the creators that plug machines in (E2c), node 1 then node 2

Only after step 5. Roll the coding executor of the release head onto node 1 (the coordinator's node release path).
Its unit joins the group `qorpera-agent-plug` (it fails to start if the group is missing: steps 1 and 2 made it) and may
write the exit's client map. In the same step its policies move to `qagent0` (the executor refuses any other network):
the machine policy (`node scripts/machine-provider-policy.mjs … machines <pool> qagent0`, whose printed SQL enrolls
the new provider policy), and the coding VM policy (the executor configuration's `vmPolicy.network: "qagent0"` and the
same policy through `qorpera_configure_coding_vm_policy`). There are no machines from before (production's companies
were wiped on 3 October).

Check:
- `systemctl is-active qorpera-coding-executor` is `active`, and its log shows no `INVALID_CODING_MACHINE_BINDING`
  or `INVALID_COMPANY_MACHINE_POLICY`;
- start a disposable agents' machine through the product (or wait for the next one): within a minute `X status`
  shows one entry in the client map and a port on `qagent0`, `X verify` stays healthy, and the machine reaches a
  website (`curl -sI https://example.com` from it) while `nc -zw2 192.168.1.40 2049` from it is refused;
- `tail -1 /var/log/qorpera-agent-exit/clients-$(date -u +%F).jsonl` shows its `plugged` line with its company.

Undo: roll the node back to its previous coding executor (the node release path). Plugged machines keep their entries
until they are deleted; the exit stays up while any is in the client map.

Then node 2, the same way.

## After the rollout

- The exit's own log: `/var/log/qorpera-agent-exit/flows-*.jsonl` and `clients-*.jsonl` (E3 ships them to the NAS).
- A node whose exit turns unhealthy keeps its running machines; new ones go to the other node. A sleeping agent's
  machine that wakes there is refused (`NODE_AGENT_EXIT_UNHEALTHY`) and moves to the other node; one tied to its
  repository's node waits. When no node has a healthy exit, a new agent's machine waits as for room
  (no candidate is left). Repair: `systemctl reload qorpera-agent-exit.service` (`README.md`, "Health and failure").
- The Company Computer's second card comes with E6 and the next office image; until then its browser keeps its own
  network.
