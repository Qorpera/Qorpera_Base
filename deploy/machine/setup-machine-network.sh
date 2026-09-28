#!/bin/bash
# Company machines' own LXD network on one node (run as root on the node).
#
#   setup-machine-network.sh [network] [gateway-cidr]
#
# A NAT bridge separate from every other LXD network (offices refuse networks
# that carry ACLs, lxd-client.ts), IPv4 only, with an ACL that lets machines
# reach the internet and nothing of ours: every private, shared-address,
# link-local, loopback and special range is dropped, which covers the NAS and
# the node LAN (192.168.0.0/16), Tailscale (100.64.0.0/10), cloud metadata
# (169.254.0.0/16) and the other LXD bridges and the node itself (10.0.0.0/8).
# DHCP and DNS to the bridge stay allowed (LXD's baseline rules). Nothing may
# come in. Machines on the bridge cannot reach each other either: their NICs
# carry port isolation and MAC/IPv4 filtering (company-machine.ts).
#
# Idempotent: an existing network or ACL is checked, never replaced.
set -euo pipefail
NET=${1:-machine-net}
CIDR=${2:-10.88.0.1/22}
ACL="${NET}-egress"
DROP=(
	0.0.0.0/8
	10.0.0.0/8
	100.64.0.0/10
	127.0.0.0/8
	169.254.0.0/16
	172.16.0.0/12
	192.0.0.0/24
	192.168.0.0/16
	198.18.0.0/15
	224.0.0.0/4
	240.0.0.0/4
)
[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ $NET =~ ^[a-z][a-z0-9-]{0,14}$ ]] || { echo "invalid network name" >&2; exit 1; }
[[ $CIDR =~ ^10\.[0-9]{1,3}\.[0-9]{1,3}\.1/2[0-4]$ ]] || { echo "gateway must be 10.x.y.1/20-24" >&2; exit 1; }

if ! lxc network show "$NET" >/dev/null 2>&1; then
	lxc network create "$NET" --type=bridge ipv4.address="$CIDR" ipv4.nat=true ipv4.dhcp=true ipv6.address=none \
		dns.mode=managed description="Qorpera company machines: internet out, nothing of ours, nothing in"
fi
if ! lxc network acl show "$ACL" >/dev/null 2>&1; then
	lxc network acl create "$ACL" description="Qorpera company machines: drop private and special ranges"
	for destination in "${DROP[@]}"; do
		lxc network acl rule add "$ACL" egress action=drop destination="$destination" state=enabled
	done
fi
lxc network set "$NET" security.acls="$ACL" security.acls.default.egress.action=allow security.acls.default.ingress.action=drop

# Evidence for the rollout record: the exact network and ACL as LXD holds them.
lxc network show "$NET"
lxc network acl show "$ACL"
for destination in "${DROP[@]}"; do
	lxc network acl show "$ACL" | grep -q -- "destination: $destination" || { echo "ACL misses $destination" >&2; exit 1; }
done
[[ $(lxc network get "$NET" ipv4.address) == "$CIDR" ]] || { echo "network $NET has another address" >&2; exit 1; }
echo "machine network $NET ready with $ACL"
