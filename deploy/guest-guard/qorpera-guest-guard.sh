#!/usr/bin/env bash
# Qorpera guest guard (E-1): loads, switches, shows or removes the nftables table that keeps machines on our
# LXD bridges away from the NAS, the office network, the nodes, Tailscale and each other. Run as root.
#
#   qorpera-guest-guard.sh check          parse both modes and compare this node's bridges with the rules
#   qorpera-guest-guard.sh observe        load: count and log what would be refused, refuse nothing
#   qorpera-guest-guard.sh enforce        load: refuse it; refused when a bridge does not match the rules
#   qorpera-guest-guard.sh boot           load the mode named in /etc/qorpera-guest-guard/mode (the unit)
#   qorpera-guest-guard.sh verify         exit 0 only when the loaded mode is the mode file's (none: not loaded)
#   qorpera-guest-guard.sh status         mode, counters and this node's bridges
#   qorpera-guest-guard.sh log [SINCE]    refused flows from the kernel log, counted (default: -2h)
#   qorpera-guest-guard.sh summarize      the same count, reading kernel log lines from stdin
#   qorpera-guest-guard.sh remove         delete the table: the exact undo, immediate
#   qorpera-guest-guard.sh probe PROJECT INSTANCE
#                                         connect tests from inside one guest on qorpera0 (lxc exec)
set -euo pipefail
((BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4))) || {
	echo "qorpera-guest-guard: needs bash 4.4 or later" >&2
	exit 69
}
shopt -s inherit_errexit

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
rules=${QORPERA_GUEST_GUARD_RULES:-$here/qorpera-guest-guard.nft}
mode_file=${QORPERA_GUEST_GUARD_MODE_FILE:-/etc/qorpera-guest-guard/mode}
table="inet qorpera_guest_guard"

usage() {
	sed -n '5,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
	exit 64
}

die() {
	echo "qorpera-guest-guard: $*" >&2
	exit 1
}

# One nft batch: create the table if missing, delete it, then the whole table again, plus the refusals in
# enforce mode. The kernel applies all of it or none of it, so there is no moment without the table.
batch() {
	[[ -r $rules ]] || die "cannot read $rules; the loaded table is unchanged"
	grep -q '^table inet qorpera_guest_guard {$' "$rules" || die "$rules does not define the table; the loaded table is unchanged"
	printf 'table %s\ndelete table %s\n' "$table" "$table"
	cat -- "$rules" || die "cannot read $rules; the loaded table is unchanged"
	if [[ $1 == enforce ]]; then
		printf 'add rule %s %s\n' \
			"$table" "refuse_forward meta l4proto tcp reject with tcp reset" \
			"$table" "refuse_forward reject with icmpx admin-prohibited" \
			"$table" "refuse_input meta l4proto tcp reject with tcp reset" \
			"$table" "refuse_input reject with icmpx admin-prohibited" \
			"$table" "refuse_spoofed drop" \
			"$table" "refuse_invalid drop" \
			"$table" "refuse_related drop" \
			"$table" "refuse_quiet drop"
	fi
}

# 0: loaded, 1: not loaded. Anything else nft says (no permission, no netlink) stops the script.
loaded() {
	local err
	if err=$(nft list table $table 2>&1 >/dev/null); then return 0; fi
	[[ $err == *"No such file or directory"* ]] && return 1
	die "nft cannot read the table: $err"
}

current_mode() {
	local chain
	if ! loaded; then
		echo "not loaded"
		return
	fi
	chain=$(nft list chain $table refuse_input)
	if [[ $chain == *reject* ]]; then echo enforce; else echo observe; fi
}

# The mode file says observe or enforce; without it the guard is not wanted.
wanted_mode() {
	local mode
	if [[ ! -e $mode_file ]]; then
		echo "not loaded"
		return
	fi
	mode=$(cat -- "$mode_file")
	[[ $mode == observe || $mode == enforce ]] || {
		echo "qorpera-guest-guard: $mode_file says '$mode'; expected observe or enforce" >&2
		exit 78
	}
	echo "$mode"
}

# The elements of one set in the rules file, one "bridge value" per line.
set_elements() {
	awk -v name="$1" '
		$0 ~ "^\tset " name " \\{$" { inside = 1; next }
		inside && /^\t}$/ { inside = 0 }
		inside { print }
	' "$rules" | grep -o '"[A-Za-z0-9_.-]*"\( \. [0-9./]*\)\{0,1\}' | sed 's/"\([^"]*\)"\( \. \)\{0,1\}/\1 /'
}

# Compares the bridges on this node with the rules. Prints one line per bridge; a line starting with
# MISMATCH means enforce would cut that bridge's guests off (or miss them), NOT GUARDED a bridge the rules do
# not name. Returns 1 when there is a mismatch, 2 when there is only an unguarded bridge.
compare_bridges() {
	local bridge subnet gateway prefix route v6 status=0
	local -A subnets=() gateways=() guarded=()
	while read -r bridge _; do guarded[$bridge]=1; done < <(set_elements guest_bridges)
	while read -r bridge subnet; do subnets[$bridge]=$subnet; done < <(set_elements bridge_subnets)
	while read -r bridge gateway; do gateways[$bridge]=$gateway; done < <(set_elements bridge_gateways)
	for bridge in $(ip -o link show type bridge | awk -F': ' '{print $2}' | cut -d@ -f1); do
		if [[ -z ${guarded[$bridge]:-} ]]; then
			echo "NOT GUARDED bridge $bridge (add it to guest_bridges, bridge_subnets and bridge_gateways)"
			[[ $status -eq 1 ]] || status=2
			continue
		fi
		subnet=${subnets[$bridge]:-}
		gateway=${gateways[$bridge]:-}
		prefix=${subnet#*/}
		route=$(ip -o -4 route show dev "$bridge" proto kernel scope link | awk '{ for (i = 2; i < NF; i++) if ($i == "src") print $1, $(i + 1) }' | tr '\n' ' ')
		v6=$(ip -o -6 addr show dev "$bridge" scope global | awk '{print $4}' | tr '\n' ' ')
		if [[ $route != "$subnet $gateway " ]]; then
			echo "MISMATCH bridge $bridge: has '${route% }' (network and address), rules say '$subnet $gateway'"
			status=1
		elif [[ -n $v6 ]]; then
			echo "MISMATCH bridge $bridge: has IPv6 ${v6% }; the guard drops all guest IPv6, so guests would time out"
			status=1
		else
			echo "bridge $bridge: matches ($gateway/$prefix)"
		fi
	done
	return $status
}

br_netfilter() { cat "${QORPERA_GUEST_GUARD_BR_NETFILTER:-/proc/sys/net/bridge/bridge-nf-call-iptables}" 2>/dev/null || echo "not loaded"; }

# The batch is built and dry-run in full before it is applied, so a bad file never removes a loaded table.
load() {
	local text
	if [[ $1 == enforce && ${QORPERA_GUEST_GUARD_FORCE:-0} != 1 ]]; then
		compare_bridges >/dev/null || [[ $? -eq 2 ]] || {
			compare_bridges | grep '^MISMATCH' >&2 || true
			die "refusing to enforce: a bridge does not match the rules (QORPERA_GUEST_GUARD_FORCE=1 overrides)"
		}
	fi
	text=$(batch "$1")
	nft -c -f /dev/stdin <<<"$text"
	nft -f /dev/stdin <<<"$text"
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

check() {
	local status=0
	batch enforce | nft -c -f /dev/stdin
	echo "rules parse (both modes); current mode: $(current_mode); mode file: $(wanted_mode)"
	compare_bridges || status=$?
	echo "br_netfilter: $(br_netfilter) (1: guests on one bridge are checked against each other too)"
	echo "nftables.service: $(systemctl is-enabled nftables.service 2>/dev/null || true) (must stay disabled: /etc/nftables.conf flushes every table)"
	return $status
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
		state=$(lxc exec --project "$project" "$instance" -- bash -c "$test_one" _ "$target" </dev/null) || state=error
		printf '%-24s %-6s expected open\n' "$target" "$state"
		[[ $state == open ]] || failures=$((failures + 1))
	done
	for target in $refused; do
		state=$(lxc exec --project "$project" "$instance" -- bash -c "$test_one" _ "$target" </dev/null) || state=error
		printf '%-24s %-6s expected closed%s\n' "$target" "$state" "$([[ $mode == enforce ]] || echo ' (observe: only counted)')"
		if [[ $state == error || ($mode == enforce && $state != closed) ]]; then failures=$((failures + 1)); fi
	done
	echo "unexpected results: $failures"
	[[ $failures -eq 0 ]]
}

case "${1:-}" in
check) check ;;
observe | enforce) load "$1" ;;
boot)
	mode=$(wanted_mode)
	[[ $mode != "not loaded" ]] || die "no mode file ($mode_file); nothing to load"
	load "$mode"
	;;
verify)
	wanted=$(wanted_mode)
	actual=$(current_mode)
	netfilter=$(br_netfilter)
	echo "qorpera-guest-guard: loaded $actual, wanted $wanted; br_netfilter $netfilter"
	[[ $actual == "$wanted" ]]
	[[ $actual == "not loaded" || $netfilter == 1 ]]
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
