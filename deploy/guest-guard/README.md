# Guest guard (E-1)

Keeps the machines on our LXD bridges away from our own networks. Guests keep the internet, their own
bridge's DNS and DHCP, and the short list of our services below. They no longer reach the NAS, the office
network, the nodes' SSH and rpcbind, other tailnet devices, link-local addresses or another bridge's guests.

One nftables table, `inet qorpera_guest_guard`, the same file on every node. Only connections a guest starts
are checked: new connections arriving from a guest bridge (`ct state new`). Replies, and connections the node
opens to a guest, pass untouched. Refusals answer at once (TCP reset, otherwise ICMP admin-prohibited), so a
blocked call fails fast instead of timing out.

This is step E-1 of the agent exit design (https://claude.ai/artifact/GPjfKe2YagNeMzkQMrY95r). It comes
first because it closes a hole that exists today.

## Why

On 2026-10-02 the coordinator ran TCP connects (read-only) from inside `qorpera-exec-node02` (project
`qn25b2`, node 2), the fast host that runs agent work. All of these connected:

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
| DNS | every guest bridge | its own gateway, 53 UDP and TCP | LXD dnsmasq listens on each gateway (`ss -ltn`, `ss -lun`) |
| DHCP | every guest bridge | 67 UDP, broadcast included | dnsmasq on `%<bridge>:67` |
| Internet: database, model relay, GitHub, npm, apt | every guest | public addresses | not in `internal4` |
| Coding command gateway | `qorpera0` | `10.41.0.1:8789` | `node.json` `QORPERA_CODING_COMMAND_URL`; node 2 nginx (`/etc/qorpera-coding-gateway/nginx.conf`); node 1 `qorpera-coding-forward.socket` forwards to node 2's tailnet listener |
| Object gateway and vault front door | `qorpera0`, both nodes | `100.75.4.70:10000` | `node.json` `QORPERA_NATIVE_OBJECT_GATEWAY_URL` = `https://company41-node-01.tailbb15c7.ts.net:10000`, which guests resolve to `100.75.4.70` (`getent` inside the fast host); office `captureObjectGatewayUrl`; Funnel 10000 → `127.0.0.1:18446` |
| Node 1's other Funnel doors | `qorpera0` | `100.75.4.70:443`, `:8443` | `tailscale serve status`; public through Funnel anyway |
| Company Computer links (office passthrough) | `qorpera0` | `100.75.4.70:18543/18544` (production), `18443/18444` (phql office), `8443/8444` (acceptance office) | socket units on node 1; `passthrough.json` `allowedClients` = `100.64.0.0/10`, `10.41.0.0/24` |
| Node 2's Funnel door (login gateway) | `qorpera0` | `100.80.160.64:10000` | `tailscale serve status` on node 2 |

Refused: the NAS, the router, both nodes' LAN addresses, SSH and rpcbind on any node address, every other
tailnet address and port, link-local and metadata addresses, our public address `93.164.62.162`, other
bridges' gateways and guests, and IPv6. The NAS is not on the list because the office workbench, objects,
recovery and the coding fleet are NFS mounts on the node host, never in a guest (the office gate mounts the
workbench on the host: `packages/runner-orchestrator/src/lxd-office-physical-host.ts`).

Not checked, because the node opens them: provider assignment (8082) and native bridge (8083) into job VMs and
the fast host, the office passthrough into office VMs, the coding executor into coding machines, and SSH into
the test machine.

Unconfirmed until observe mode runs: node 1's LXD inventory (the author has no LXD access on node 1), and the
orchestrator VM `10.41.0.2`, whose `QORPERA_RUNNER_PROVIDER_URL` names `https://10.41.0.1:8081`, where nothing
listens on node 1 today.

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

1. **Inventory (node 1, read-only).** Compare with the table above:

   ```bash
   lxc project list -f csv
   lxc network list -f csv
   for p in $(lxc project list -f csv | cut -d, -f1 | sed 's/ (current)//'); do echo "== $p"; lxc list --project "$p" -f csv -c ns4t; done
   lxc network show qorpera0; lxc network show coding-net; lxc network show qofficebuild0
   lxc network acl list -f csv
   lxc network list-leases qorpera0
   nft list tables
   ```

2. **Install.** `bash deploy/guest-guard/install-guest-guard.sh`. It verifies the pins, copies the files,
   reloads systemd and runs `G check`, which parses both modes against the kernel and names any bridge on
   the node that the rules do not cover. It loads and enables nothing.

3. **Phase 0, observe (about an hour).** `G observe`. Nothing is refused; every connection the guard would
   refuse is counted and logged (30 lines a minute at most). This lasts until reboot. Read it with:
   - `G status`: the mode and the counters `refused_forward`, `refused_input` and `allowed_services_used`;
   - `G log -1h`: refused connections from the kernel log, counted by direction, bridge, source,
     destination, protocol and port.

   Expected: no line from normal work. A line that comes from normal work (not from a probe) is a flow this
   inventory missed. Add it to `allowed_services` in a reviewed change before phase 1.
   `G probe qn25b2 qorpera-exec-node02` runs the connect tests from inside the fast host; in observe mode
   the expected-closed targets still connect and are only counted.

4. **Phase 1, enforce.**

   ```bash
   echo enforce > /etc/qorpera-guest-guard/mode
   systemctl enable --now qorpera-guest-guard.service
   ```

   Enabling loads the guard at every boot, before LXD starts any guest. `--now` replaces the observe table in
   one transaction, so there is no moment without it. Then check:
   - `G probe qn25b2 qorpera-exec-node02` ends with `unexpected results: 0`;
   - a normal agent run that reads or writes the Company File (object gateway and vault), a coding turn,
     and waking the Company Computer and opening its viewer all work;
   - `G log -30min` shows no refusal from those.

5. **Undo, immediate.**

   ```bash
   systemctl disable --now qorpera-guest-guard.service
   ```

   Stopping the unit deletes the table. If it was loaded by hand (phase 0), `G remove`. To go back to
   observe instead: `echo observe > /etc/qorpera-guest-guard/mode && systemctl restart qorpera-guest-guard.service`.

## Notes

- Connections that were open before enforce keep running until they close; only new ones are checked.
- Never run `nft -f /etc/nftables.conf` and keep `nftables.service` disabled: that file starts with
  `flush ruleset`, which deletes this table and LXD's own tables.
- A new guest bridge goes into `guest_bridges` and `bridge_gateways`; `G check` names a bridge that is missing.
- A new host service that guests call goes into `allowed_services` in a reviewed change.
- The guard sees guests' traffic before LXD's NAT, so it knows the guest's own address. The NAS does not: see
  below.
- Office VM NICs have no port isolation, so two guests on `qorpera0` can still reach each other over the
  bridge itself; that traffic is switched, not routed, and this guard does not see it.

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
