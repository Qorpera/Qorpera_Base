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
# LXD applies drop and reject rules before allow rules, and its baseline DHCP
# and DNS allowances do not open a hole in them (seen on node 2, 2026-09-28,
# deploy/test-machine/README.md). So the dropped ranges leave out exactly two
# addresses: the bridge's gateway, where TCP and UDP stay open only for DNS (53)
# and DHCP (67) (ICMP to it is not dropped), and 255.255.255.255, where a DHCP
# discover goes. Nothing may come in. Machines on the bridge cannot reach each
# other: their NICs carry port isolation and MAC/IPv4 filtering
# (company-machine.ts).
#
# An ACL made before 2026-09-28 drops 10/8 and 240/4 whole, so its machines get
# no address; the script refuses it. Replace it by hand, then run this again:
#   lxc network unset <network> security.acls && lxc network acl delete <network>-egress
#
# Idempotent: an existing network or ACL is checked, never replaced.
set -euo pipefail
NET=${1:-machine-net}
CIDR=${2:-10.88.0.1/22}
ACL="${NET}-egress"
DROP=(
	0.0.0.0/8
	100.64.0.0/10
	127.0.0.0/8
	169.254.0.0/16
	172.16.0.0/12
	192.0.0.0/24
	192.168.0.0/16
	198.18.0.0/15
	224.0.0.0/4
)
[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ $NET =~ ^[a-z][a-z0-9-]{0,14}$ ]] || { echo "invalid network name" >&2; exit 1; }
[[ $CIDR =~ ^10\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.1/2[0-4]$ ]] || { echo "gateway must be 10.x.y.1/20-24" >&2; exit 1; }
GATEWAY=${CIDR%/*}
# A block without one address: the sibling of that address's path at every prefix length below the block's.
without() {
	local address=$1 from=$2 value=0 part p sibling
	for part in ${address//./ }; do (( part <= 255 )) || { echo "invalid address" >&2; exit 1; }; value=$(( value * 256 + part )); done
	for (( p = from + 1; p <= 32; p++ )); do
		sibling=$(( ((value >> (32 - p)) ^ 1) << (32 - p) ))
		echo "$(( sibling >> 24 & 255 )).$(( sibling >> 16 & 255 )).$(( sibling >> 8 & 255 )).$(( sibling & 255 ))/$p"
	done
}
mapfile -t -O "${#DROP[@]}" DROP < <(without "$GATEWAY" 8; without 255.255.255.255 4)
(( ${#DROP[@]} == 9 + 24 + 28 )) || { echo "ranges miscounted" >&2; exit 1; }

if ! lxc network show "$NET" >/dev/null 2>&1; then
	lxc network create "$NET" --type=bridge ipv4.address="$CIDR" ipv4.nat=true ipv4.dhcp=true ipv6.address=none \
		dns.mode=managed description="Qorpera company machines: internet out, nothing of ours, nothing in"
fi
if ! lxc network acl show "$ACL" >/dev/null 2>&1; then
	lxc network acl create "$ACL" description="Qorpera company machines: drop private and special ranges"
	for destination in "${DROP[@]}"; do
		lxc network acl rule add "$ACL" egress action=drop destination="$destination" state=enabled
	done
	# The gateway answers DNS and DHCP only.
	lxc network acl rule add "$ACL" egress action=drop destination="$GATEWAY/32" protocol=tcp destination_port=1-52,54-65535 state=enabled
	lxc network acl rule add "$ACL" egress action=drop destination="$GATEWAY/32" protocol=udp destination_port=1-52,54-66,68-65535 state=enabled
fi
lxc network set "$NET" security.acls="$ACL" security.acls.default.egress.action=allow security.acls.default.ingress.action=drop

# Evidence for the rollout record: the exact network and ACL as LXD holds them.
lxc network show "$NET"
lxc network acl show "$ACL"
RULES=$(lxc network acl show "$ACL")
for whole in 10.0.0.0/8 240.0.0.0/4; do
	# An ACL from before 2026-09-28 (see the top of this script to replace it).
	! grep -q -- "destination: $whole\$" <<<"$RULES" || { echo "ACL drops $whole whole: machines would get no address" >&2; exit 1; }
done
for destination in "${DROP[@]}"; do
	grep -q -- "destination: $destination\$" <<<"$RULES" || { echo "ACL misses $destination" >&2; exit 1; }
done
[[ $(grep -c -- "destination: $GATEWAY/32\$" <<<"$RULES") -eq 2 ]] || { echo "ACL misses the gateway's port rules" >&2; exit 1; }
[[ $(lxc network get "$NET" ipv4.address) == "$CIDR" ]] || { echo "network $NET has another address" >&2; exit 1; }
echo "machine network $NET ready with $ACL"
