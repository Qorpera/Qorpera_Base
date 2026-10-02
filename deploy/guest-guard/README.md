# Guest guard (E-1)

Keeps the machines on our LXD bridges away from our own networks. Guests keep the internet, their own
bridge's DHCP, DNS and ping, and the short list of our services below. They no longer reach the NAS, the
office network, the nodes' SSH and rpcbind, other tailnet devices, link-local addresses, our public address,
other bridges, or each other.

One nftables table, `inet qorpera_guest_guard`, the same file on every node. It looks at every packet that
arrives from a guest bridge, by input interface:

- The source must be an address of that bridge's own subnet, and never the bridge's gateway (no spoofing).
- New connections are checked against the rules; replies, and connections the node opens to a guest, pass.
  An ICMP error from a guest must concern a connection the guest is part of.
- Refused connections answer at once (TCP reset, otherwise ICMP admin-prohibited), so a blocked call fails
  fast instead of timing out. Spoofed, invalid and foreign ICMP-error packets, IPv6, and broadcast or
  multicast copies are dropped quietly.

This is step E-1 of the agent exit design (https://claude.ai/artifact/GPjfKe2YagNeMzkQMrY95r). It comes
first because it closes a hole that exists today.

## Why

On 2026-10-02 the coordinator ran TCP connects (read-only) from inside `qorpera-exec-node02` (project
`qn25b2`, node 2), the fast host. All of these connected:

- the NAS `192.168.1.40` on 2049 (NFS), 445 (SMB) and 5000 (DSM);
- SSH on both nodes (`192.168.1.27:22`, `192.168.1.42:22`) and on node 1's tailnet address (`100.75.4.70:22`);
- `10.41.0.1` on 22 and 111.

`qorpera0` has no LXD ACL and the nodes have no host firewall (`/etc/nftables.conf` is empty and
`nftables.service` is disabled), so only each service's own rules stood in the way. Both nodes mount every
company's objects, the office workbench, recovery and the coding fleet from the NAS over NFSv4. Coding machine
NICs on `coding-net` have no MAC or IP filtering, and the live `coding-egress` ACL allows every port on
`10.200.0.1`.

## What guests need

Inventory of 2026-10-02 from the repository and read-only reads of both nodes.

| Flow | From | To | Evidence |
| --- | --- | --- | --- |
| DHCP | every guest bridge | broadcast, or its own gateway, 67 UDP | dnsmasq on `%<bridge>:67` |
| DNS | every guest bridge | its own gateway, 53 UDP and TCP | LXD dnsmasq listens on each gateway (`ss -ltn`, `ss -lun`) |
| Internet: database, model relay, GitHub, npm, apt | every guest | public addresses | not in `internal4` |
| Coding command gateway | `qorpera0` | `10.41.0.1:8789` | `node.json` `QORPERA_CODING_COMMAND_URL`; node 2 nginx (`/etc/qorpera-coding-gateway/nginx.conf`); node 1 `qorpera-coding-forward.socket` forwards to node 2's tailnet listener |
| Object gateway and vault front door | `qorpera0`, both nodes | `100.75.4.70:10000` | `node.json` `QORPERA_NATIVE_OBJECT_GATEWAY_URL` and the fast host's live `QORPERA_CLOUD_SECRET_BROKER_URL` are `https://company41-node-01.tailbb15c7.ts.net:10000`, which guests resolve to `100.75.4.70` (`getent` inside the fast host); office `captureObjectGatewayUrl`; Funnel 10000 → `127.0.0.1:18446` |
| Node 1's other Funnel doors, including the recovery authority | `qorpera0` | `100.75.4.70:443`, `:8443` | `tailscale serve status` (8443 → `127.0.0.1:18546`; node 1 runs `qorpera-prod-recovery-a1`); public through Funnel anyway |
| Company Computer links (office passthrough) | `qorpera0` | `100.75.4.70:18543/18544` (production), `18443/18444` (phql office), `8443/8444` (acceptance office) | socket units on node 1; `passthrough.json` `allowedClients` = `100.64.0.0/10`, `10.41.0.0/24` |
| Node 2's Funnel door (login gateway) | `qorpera0` | `100.80.160.64:10000` | `tailscale serve status` on node 2 |
| Identity recovery (a sign-in or restore that keeps its key on a node) | `qorpera0` | the active authority's `service_origin` | read from SQL, not from env (`supabase/migrations/20260828015000_compute_identity_recovery.sql:10`, `packages/runtime/src/cloud-native-provider-host.ts:1970`). Allowed if it is node 1's `:8443` front. `deploy/cloud-secret-broker/company41/README.md` names an older tailnet address, `100.65.132.47:8443`, which is not allowed. Step 1 reads the live value. |

Refused: the NAS, the router, both nodes' LAN addresses, SSH and rpcbind on any node address, every other
tailnet address and port (anything else routed out `tailscale0`), link-local and metadata addresses, our
public address `93.164.62.162`, other bridges' gateways and guests, other guests on the same bridge, and
IPv6. The NAS is not on the list because the office workbench, objects, recovery and the coding fleet are NFS
mounts on the node host, never in a guest (the office gate mounts the workbench on the host and hands it to
the guest as a disk: `packages/runner-orchestrator/src/lxd-office-physical-host.ts`).

Not checked, because the node opens them: provider assignment (8082) and native bridge (8083) into job VMs and
the fast host, the office passthrough into office VMs, the coding executor into coding machines, and SSH into
the test machine.

Unconfirmed until steps 1 and 3 run:

- node 1's LXD inventory (the author has no LXD access on node 1);
- the recovery authority's live `service_origin` (step 1 reads it);
- old node 1 guests named in the ratification notes: an orchestrator VM `10.41.0.2` calling
  `https://10.41.0.1:8081`, where nothing listens on node 1 today, and a gateway guest at `10.41.0.3:9444`.
  If a guest still calls another guest on `qorpera0`, the guard refuses it (see "Guests on one bridge").

## Files

| File | Installed as |
| --- | --- |
| `qorpera-guest-guard.nft` | `/usr/local/libexec/qorpera-guest-guard/qorpera-guest-guard.nft` |
| `qorpera-guest-guard.sh` | `/usr/local/libexec/qorpera-guest-guard/qorpera-guest-guard.sh` |
| `qorpera-guest-guard.service` | `/etc/systemd/system/qorpera-guest-guard.service` (enabled only in phase 1) |
| `install-guest-guard.sh` | not installed; verifies the pins and copies the three files |

Edit the rules, the tool or the unit and the installer's pins must change too; the test checks them.

## Steps

As root on one node at a time, from a checkout at the reviewed head. `G` below is
`/usr/local/libexec/qorpera-guest-guard/qorpera-guest-guard.sh`.

1. **Inventory, read-only.** On node 1, compare with the table above:

   ```bash
   lxc project list -f csv
   lxc network list -f csv
   for p in $(lxc project list -f csv | cut -d, -f1 | sed 's/ (current)//'); do echo "== $p"; lxc list --project "$p" -f csv -c ns4t; done
   lxc network show qorpera0; lxc network show coding-net; lxc network show qofficebuild0
   lxc network acl list -f csv
   lxc network list-leases qorpera0
   nft list tables
   ```

   In production SQL, the recovery authorities:

   ```sql
   select id, profile_id, service_origin, status, created_at
   from public.qorpera_identity_recovery_authorities
   where status = 'active';
   ```

   If an origin resolves (from a guest: `getent ahostsv4 <host>`) to an address and port not in
   `allowed_services`, add it in a reviewed change before phase 1.

2. **Install.** `bash deploy/guest-guard/install-guest-guard.sh`. It verifies the pins, copies the files,
   reloads systemd and runs `G check`, and loads and enables nothing. The check parses both modes against
   the kernel and compares every bridge on the node with the rules:
   - `bridge <name>: matches`: its network and address are the rules' `bridge_subnets` and `bridge_gateways`;
   - `MISMATCH`: a different network or address, or a global IPv6 address. Enforce would cut that bridge's
     guests off (or leave them waiting on IPv6), so `G enforce` refuses until the rules or the bridge are
     fixed. `QORPERA_GUEST_GUARD_FORCE=1` overrides, for a deliberate exception only;
   - `NOT GUARDED`: a bridge the rules do not name. Its guests are not checked.

   It also reports br_netfilter and `nftables.service`. It exits 1 on a mismatch, 2 on an unguarded bridge.

3. **Phase 0, observe (about an hour).** `echo observe > /etc/qorpera-guest-guard/mode && G boot`. The unit
   stays disabled, so a reboot ends phase 0. Nothing is refused. Every refused packet is counted, and each
   refused flow is logged once an hour (TCP and UDP per port, other protocols per protocol; up to 10 new
   flows a second), so a frequent flow does not hide a rare one. Spoofed packets are logged too. Invalid
   packets (`refused_invalid`), foreign ICMP errors (`refused_related`), and IPv6 and broadcast or
   multicast copies (`refused_quiet`) are only counted. During the hour, run one of each:
   an agent run that reads or writes the Company File, a coding turn, the Company Computer viewer, and if
   possible a model sign-in or restore whose key stays on a node (it calls the recovery authority). Read it
   with:
   - `G status`: the mode and the counters `allowed_services_used`, `refused_forward`, `refused_input`,
     `refused_spoofed`, `refused_invalid`, `refused_related` and `refused_quiet`;
   - `G log -1h`: the logged flows, counted by direction, bridge, source, destination, protocol and port.

   Expected: no forward, input or spoofed line from normal work, and `refused_invalid` and `refused_related`
   near zero. One exception: a guest that runs nested NAT whose own table lets invalid packets out unchanged
   (#411's per-screen table in office VMs) can show `spoofed` lines with a `10.253.x.x` source; those are
   dropped in enforce and harm nothing. Any other line from normal work (not from a probe) is a flow this
   inventory missed. Add it to `allowed_services` in a reviewed change before phase 1.
   `G probe qn25b2 qorpera-exec-node02` runs the connect tests from inside the fast host; in observe mode the
   expected-closed targets still connect and are only counted.

4. **Phase 1, enforce.**

   ```bash
   echo enforce > /etc/qorpera-guest-guard/mode
   systemctl enable --now qorpera-guest-guard.service
   ```

   Enabling loads the guard at every boot, before LXD starts any guest. `--now` replaces the observe table in
   one transaction, so there is no moment without it. Then check:
   - `G verify` says `loaded enforce, wanted enforce; br_netfilter 1` and exits 0;
   - `G probe qn25b2 qorpera-exec-node02` ends with `unexpected results: 0`;
   - an agent run with the Company File, a coding turn, and waking the Company Computer and opening its
     viewer all work;
   - `G log -30min` shows no refusal from those.

   Connections that were open before enforce keep running until they close. To end them at once, enforce on a
   node that a rolling update has just emptied, or restart the guests concerned.

5. **Undo, immediate.**

   ```bash
   systemctl disable --now qorpera-guest-guard.service
   rm -f /etc/qorpera-guest-guard/mode
   ```

   Stopping the unit deletes the table. In phase 0 (loaded by hand): `G remove && rm -f /etc/qorpera-guest-guard/mode`.
   Without a mode file the guard is not wanted, and `G verify` checks that no table is loaded. To switch
   modes without a gap, change the mode file and `systemctl reload qorpera-guest-guard.service` (not
   `restart`, which removes the table for a moment).

## Guests on one bridge

Our nodes load br_netfilter (`deploy/first-node/bootstrap-lxd-host.sh`) with `bridge-nf-call-iptables=1`.
Then a packet one guest sends to another guest on the same bridge also passes the forward hook, with the
bridge as its input interface. The guard refuses such new connections like any other private destination,
and drops broadcast and multicast copies quietly (a guest's own DHCP still works). This separates guests
whose NICs have no port isolation, such as office VMs and coding machines. Port isolation stays the real
layer-2 control: the guard does not see non-IP frames or VLAN-tagged frames.

## Notes

- Never run `nft -f /etc/nftables.conf` and keep `nftables.service` disabled: that file starts with
  `flush ruleset`, which deletes this table and LXD's own tables. The unit is ordered after
  `nftables.service` in case it is ever enabled again.
- If the guard fails to load at boot, LXD still starts and guests run without it. `G verify` is the check for
  monitoring and node parity: exit 0 only when the loaded mode is the mode file's (no file: no table) and,
  while loaded, br_netfilter is on.
- A new guest bridge goes into `guest_bridges`, `bridge_subnets` and `bridge_gateways`; `G check` names a
  bridge that is missing.
- A new host service that guests call goes into `allowed_services` in a reviewed change.
- Our public address `93.164.62.162` is written into `internal4`. If TDC changes it, change the file.
- Anything a guest sends out `tailscale0` that is not listed is refused. If a later step (the agent exit)
  routes guests through a Tailscale exit node, that rule has to change with it.
- The kernel already drops packets whose source is one of the node's own addresses (martian source), so the
  gateway-address rule is a second line.
- The guard sees guests' traffic before LXD's NAT, so it knows the guest's own address. The NAS does not: see
  below.

## Test

`qorpera-guest-guard.test.mjs` checks the pins, runs the tool against a stand-in `nft`, and as root on Linux
loads the real rules into a stand-in node built from network namespaces: two guests on `qorpera0`, one on
`coding-net`, the office network with the NAS and the router, and node 1 on the tailnet. It covers no guard,
observe (exact counts), enforce (TCP, UDP DNS, ping, IPv6, spoofed sources, cross-bridge and same-bridge
refusals), switching back and removal. Routine `run-on-node.mjs changed` runs as a normal user and skips the
root part. Run it on the test machine with:

```bash
node scripts/run-on-node.mjs --sudo --no-install --env QORPERA_GUEST_GUARD_TEST_BR_NETFILTER=1 -- node --test deploy/guest-guard/qorpera-guest-guard.test.mjs
```

The variable loads br_netfilter for the run (the test machine does not load it) and unloads it afterwards.

## The NAS (for Jonas, in DSM)

1. **Control Panel → Shared Folder →** each folder the nodes mount (the company objects, the runtime
   workbench, recovery and coding folders) **→ Edit → NFS Permissions.** For each rule, note:
   - **Hostname or IP:** should be exactly `192.168.1.27` and `192.168.1.42`, not `*` or `192.168.1.0/24`;
   - **Squash:** which mapping it uses;
   - **Allow connections from non-privileged ports:** should be off;
   - **Security:** `sys` is expected.
2. **Control Panel → Security → Firewall:** is it on, and which rules does it have?
3. **Can the NAS firewall alone limit 2049, 445 and 5000 to the two nodes?** Partly. Guests reach the NAS
   through their node's NAT, so the NAS sees the node's own address for the node and for every guest on it.
   - For NFS (2049), which the nodes need, the NAS cannot tell a guest from its node. Only this guard
     separates them.
   - For SMB (445) and DSM (5000, 5001), which the nodes do not use, a firewall rule that allows them only
     from the devices that need them (and not from `.27` or `.42`) keeps every guest out, and other office
     devices too.
   - Turning off non-privileged ports helps only a little: root inside a guest can use a privileged port,
     and the NAT keeps it.
