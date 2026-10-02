#!/usr/bin/env bash
# Qorpera guest guard (E-1): loads, switches, shows or removes the nftables table that keeps machines on our
# LXD bridges away from the NAS, the office network, the nodes and Tailscale. Run as root on a node.
#
#   qorpera-guest-guard.sh check          parse both modes against the kernel; change nothing
#   qorpera-guest-guard.sh observe        load: count and log what would be refused, refuse nothing
#   qorpera-guest-guard.sh enforce        load: refuse it (TCP reset, otherwise ICMP admin-prohibited)
#   qorpera-guest-guard.sh boot           load the mode named in /etc/qorpera-guest-guard/mode (the unit)
#   qorpera-guest-guard.sh status         mode, counters and this node's bridges
#   qorpera-guest-guard.sh log [SINCE]    refused connections from the kernel log, counted (default: -2h)
#   qorpera-guest-guard.sh summarize      the same count, reading kernel log lines from stdin
#   qorpera-guest-guard.sh remove         delete the table: the exact undo, immediate
#   qorpera-guest-guard.sh probe PROJECT INSTANCE
#                                         connect tests from inside one guest on qorpera0 (lxc exec)
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
rules=${QORPERA_GUEST_GUARD_RULES:-$here/qorpera-guest-guard.nft}
mode_file=${QORPERA_GUEST_GUARD_MODE_FILE:-/etc/qorpera-guest-guard/mode}
table="inet qorpera_guest_guard"

usage() {
	sed -n '5,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
	exit 64
}

# One nft transaction: create the table if missing, delete it, then the whole table again, plus the rejects
# in enforce mode. The kernel applies all of it or none of it, so there is no moment without the table.
transaction() {
	printf 'table %s\ndelete table %s\n' "$table" "$table"
	cat "$rules"
	if [[ $1 == enforce ]]; then
		printf 'add rule %s %s\n' \
			"$table" "refuse_forward meta l4proto tcp reject with tcp reset" \
			"$table" "refuse_forward reject with icmpx admin-prohibited" \
			"$table" "refuse_input meta l4proto tcp reject with tcp reset" \
			"$table" "refuse_input reject with icmpx admin-prohibited"
	fi
}

loaded() { nft list table $table >/dev/null 2>&1; }

current_mode() {
	local chain
	if ! loaded; then
		echo "not loaded"
		return
	fi
	chain=$(nft list chain $table refuse_input)
	if [[ $chain == *reject* ]]; then echo enforce; else echo observe; fi
}

load() {
	transaction "$1" | nft -f /dev/stdin
	echo "qorpera-guest-guard: $(current_mode)"
}

# Kernel log lines (nft log prefix) to "count direction bridge source destination protocol port".
summarize() {
	sed -n 's/.*qorpera-guest-guard \([a-z]*\): \(.*\)/\1 \2/p' |
		awk '{
			dir = $1; inif = "-"; src = "-"; dst = "-"; proto = "-"; dpt = "-"
			for (i = 2; i <= NF; i++) {
				split($i, kv, "=")
				if (kv[1] == "IN") inif = kv[2]
				else if (kv[1] == "SRC") src = kv[2]
				else if (kv[1] == "DST") dst = kv[2]
				else if (kv[1] == "PROTO") proto = kv[2]
				else if (kv[1] == "DPT") dpt = kv[2]
			}
			print dir, inif, src, dst, proto, dpt
		}' | sort | uniq -c | sort -rn
}

probe() {
	local project=$1 instance=$2
	# Expected to connect: the bridge's DNS, the coding command gateway, node 1's object gateway and vault
	# front door, and one internet address. Expected to be refused in enforce mode: everything else here.
	local open="10.41.0.1:53 10.41.0.1:8789 100.75.4.70:10000 1.1.1.1:443"
	local refused="10.41.0.1:22 10.41.0.1:111 192.168.1.40:2049 192.168.1.40:445 192.168.1.40:5000 \
192.168.1.27:22 192.168.1.42:22 192.168.1.1:80 100.75.4.70:22 100.80.160.64:22 169.254.169.254:80"
	local mode failures=0 target state
	mode=$(current_mode)
	echo "guard mode on this node: $mode"
	# shellcheck disable=SC2016 # expanded inside the guest
	local test_one='timeout 4 bash -c "exec 3<>/dev/tcp/${1%:*}/${1##*:}" 2>/dev/null && echo open || echo closed'
	for target in $open; do
		state=$(lxc exec --project "$project" "$instance" -- bash -c "$test_one" _ "$target" </dev/null)
		printf '%-24s %-6s expected open\n' "$target" "$state"
		[[ $state == open ]] || failures=$((failures + 1))
	done
	for target in $refused; do
		state=$(lxc exec --project "$project" "$instance" -- bash -c "$test_one" _ "$target" </dev/null)
		printf '%-24s %-6s expected closed%s\n' "$target" "$state" "$([[ $mode == enforce ]] || echo ' (observe: only counted)')"
		if [[ $mode == enforce && $state != closed ]]; then failures=$((failures + 1)); fi
	done
	echo "unexpected results: $failures"
	[[ $failures -eq 0 ]]
}

case "${1:-}" in
check)
	transaction enforce | nft -c -f /dev/stdin
	echo "rules parse (both modes); current mode: $(current_mode)"
	for bridge in $(ip -o link show type bridge | awk -F': ' '{print $2}' | cut -d@ -f1); do
		if grep -q "\"$bridge\"" "$rules"; then echo "bridge $bridge: guarded"; else echo "bridge $bridge: NOT in guest_bridges"; fi
	done
	;;
observe | enforce) load "$1" ;;
boot)
	mode=$(cat "$mode_file" 2>/dev/null || echo observe)
	[[ $mode == observe || $mode == enforce ]] || {
		echo "qorpera-guest-guard: $mode_file says '$mode'; expected observe or enforce" >&2
		exit 78
	}
	load "$mode"
	;;
status)
	echo "mode: $(current_mode)"
	if loaded; then nft list counters table $table; fi
	ip -o link show type bridge | awk -F': ' '{print "bridge on this node: " $2}'
	;;
log) journalctl -k --since "${2:--2h}" -o cat | summarize ;;
summarize) summarize ;;
remove)
	if loaded; then nft delete table $table; fi
	echo "qorpera-guest-guard: $(current_mode)"
	;;
probe)
	[[ $# -eq 3 ]] || usage
	probe "$2" "$3"
	;;
*) usage ;;
esac
