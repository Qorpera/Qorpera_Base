#!/usr/bin/env bash
# Qorpera agent exit (E1): builds, checks or removes the exit on one node. Run as root.
#
#   qorpera-agent-exit.sh check     parse both rule files against the kernel; change nothing
#   qorpera-agent-exit.sh up        create (or repair) the namespace, bridge, uplink, addresses and both rule tables
#   qorpera-agent-exit.sh down      remove all of it; refused while an agent machine is plugged in (--force overrides)
#   qorpera-agent-exit.sh dns       run dnsmasq in the exit, in the foreground (the dns unit)
#   qorpera-agent-exit.sh log       run the connection logger in the foreground (the log unit)
#   qorpera-agent-exit.sh verify    exit 0 only when every part is up and the logger is alive
#   qorpera-agent-exit.sh status    addresses, counters and plugged-in machines
#
# Layout (README.md): namespace qexit; bridge qagent0 on the node with no address; veth qx-br (node, a port of
# qagent0) / br0 (exit, 10.210.0.1/16); uplink veth qx-up (node, 10.209.255.1/30) / up0 (exit, 10.209.255.2/30).
set -euo pipefail
((BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4))) || {
	echo "qorpera-agent-exit: needs bash 4.4 or later" >&2
	exit 69
}
shopt -s inherit_errexit

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exit_rules=${QORPERA_AGENT_EXIT_RULES:-$here/qorpera-agent-exit.nft}
host_rules=${QORPERA_AGENT_EXIT_HOST_RULES:-$here/qorpera-agent-exit-host.nft}
logger=${QORPERA_AGENT_EXIT_LOGGER:-$here/qorpera-agent-exit-log.py}
upstreams=${QORPERA_AGENT_EXIT_UPSTREAMS:-9.9.9.9 1.1.1.1}
run_dir=${QORPERA_AGENT_EXIT_RUN_DIR:-/run/qorpera-agent-exit}
state_dir=${QORPERA_AGENT_EXIT_STATE_DIR:-/var/lib/qorpera-agent-exit}
log_dir=${QORPERA_AGENT_EXIT_LOG_DIR:-/var/log/qorpera-agent-exit}

NS=qexit
BRIDGE=qagent0
GATEWAY=10.210.0.1
AGENTS=10.210.0.0/16
UP_NODE=10.209.255.1
UP_EXIT=10.209.255.2
EXIT_TABLE="inet qorpera_agent_exit"
HOST_TABLE="inet qorpera_agent_exit_host"

usage() {
	sed -n '4,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
	exit 64
}

die() {
	echo "qorpera-agent-exit: $*" >&2
	exit 1
}

in_exit() { ip netns exec "$NS" "$@"; }
has_ns() { [[ -e /run/netns/$NS ]]; }
has_link() { ip link show dev "$1" >/dev/null 2>&1; }

# One nft batch per table: create it if missing, delete it, define it again. The kernel applies all or none.
table_batch() {
	local table=$1 file=$2
	[[ -r $file ]] || die "cannot read $file"
	grep -q "^table $table {\$" "$file" || die "$file does not define table $table"
	printf 'table %s\ndelete table %s\n' "$table" "$table"
	cat -- "$file" || die "cannot read $file"
}

load_tables() {
	local exit_text host_text
	exit_text=$(table_batch "$EXIT_TABLE" "$exit_rules")
	host_text=$(table_batch "$HOST_TABLE" "$host_rules")
	in_exit nft -c -f /dev/stdin <<<"$exit_text"
	nft -c -f /dev/stdin <<<"$host_text"
	in_exit nft -f /dev/stdin <<<"$exit_text"
	nft -f /dev/stdin <<<"$host_text"
}

up() {
	mkdir -p "$run_dir" "$state_dir/dhcp-hosts" "$log_dir"
	has_ns || ip netns add "$NS"
	in_exit ip link set lo up
	in_exit sysctl -qw net.ipv4.ip_forward=1 net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1
	if ! has_link "$BRIDGE"; then
		ip link add "$BRIDGE" type bridge
		sysctl -qw "net.ipv6.conf.$BRIDGE.disable_ipv6=1"
	fi
	ip link set "$BRIDGE" up
	if ! has_link qx-br; then
		ip link add qx-br type veth peer name br0 netns "$NS"
		sysctl -qw net.ipv6.conf.qx-br.disable_ipv6=1
	fi
	ip link set qx-br master "$BRIDGE" up
	in_exit ip addr replace "$GATEWAY/16" dev br0
	in_exit ip link set br0 up
	if ! has_link qx-up; then
		ip link add qx-up type veth peer name up0 netns "$NS"
		sysctl -qw net.ipv6.conf.qx-up.disable_ipv6=1
	fi
	ip addr replace "$UP_NODE/30" dev qx-up
	ip link set qx-up up
	in_exit ip addr replace "$UP_EXIT/30" dev up0
	in_exit ip link set up0 up
	in_exit ip route replace default via "$UP_NODE" dev up0
	# Connection bytes for the log; set after the namespace has conntrack (the first table load registers it).
	load_tables
	in_exit sysctl -qw net.netfilter.nf_conntrack_acct=1
	[[ $(cat /proc/sys/net/ipv4/ip_forward) == 1 ]] || die "the node does not forward IPv4 (net.ipv4.ip_forward=0)"
	echo "qorpera-agent-exit: up"
}

plugged() { ip -o link show master "$BRIDGE" 2>/dev/null | awk -F': ' '{print $2}' | cut -d@ -f1 | grep -vx qx-br || true; }

down() {
	local machines
	if has_link "$BRIDGE"; then
		machines=$(plugged)
		if [[ -n $machines && ${1:-} != --force ]]; then
			die "agent machines are plugged in ($(echo "$machines" | tr '\n' ' ')); empty the node first or pass --force"
		fi
	fi
	if nft list table $HOST_TABLE >/dev/null 2>&1; then nft delete table $HOST_TABLE; fi
	if has_ns; then ip netns del "$NS"; fi
	if has_link "$BRIDGE"; then ip link del "$BRIDGE"; fi
	if has_link qx-up; then ip link del qx-up; fi
	echo "qorpera-agent-exit: down"
}

dns() {
	local args=() server
	has_ns || die "the exit is not up"
	for server in $upstreams; do args+=("--server=$server"); done
	mkdir -p "$state_dir/dhcp-hosts"
	# Static leases only: the agent plug (E2) writes one "mac,address,name" file per machine into dhcp-hosts.
	exec ip netns exec "$NS" dnsmasq --keep-in-foreground --conf-file=/dev/null --pid-file= \
		--no-resolv --no-hosts --no-poll --bind-interfaces --interface=br0 --listen-address="$GATEWAY" \
		"${args[@]}" \
		--dhcp-range="${AGENTS%/*},static,255.255.0.0,12h" --dhcp-authoritative \
		--dhcp-hostsdir="$state_dir/dhcp-hosts" \
		--dhcp-option=option:router,"$GATEWAY" --dhcp-option=option:dns-server,"$GATEWAY" \
		--log-queries=extra --log-dhcp --log-facility=- --log-async=50
}

log() {
	has_ns || die "the exit is not up"
	mkdir -p "$log_dir" "$run_dir"
	exec python3 "$logger" --netns "$NS" --log-dir "$log_dir" --heartbeat "$run_dir/logger.heartbeat"
}

verify() {
	local problems=() heartbeat age
	has_ns || problems+=("no namespace $NS")
	has_link "$BRIDGE" || problems+=("no bridge $BRIDGE")
	if has_ns; then
		in_exit ip -o -4 addr show dev br0 2>/dev/null | grep -q " $GATEWAY/16 " || problems+=("br0 lacks $GATEWAY/16")
		in_exit ip -o -4 addr show dev up0 2>/dev/null | grep -q " $UP_EXIT/30 " || problems+=("up0 lacks $UP_EXIT/30")
		in_exit ip route show default 2>/dev/null | grep -q "via $UP_NODE" || problems+=("no default route via $UP_NODE")
		in_exit nft list table $EXIT_TABLE >/dev/null 2>&1 || problems+=("exit rules not loaded")
		in_exit ss -lnu 2>/dev/null | grep -q "$GATEWAY:53 " || problems+=("no DNS on $GATEWAY:53")
	fi
	nft list table $HOST_TABLE >/dev/null 2>&1 || problems+=("node rules not loaded")
	heartbeat="$run_dir/logger.heartbeat"
	if [[ -e $heartbeat ]]; then
		age=$(($(date +%s) - $(stat -c %Y "$heartbeat")))
		((age < 60)) || problems+=("logger silent for ${age}s")
	else
		problems+=("logger not running")
	fi
	if ((${#problems[@]} > 0)); then
		printf 'qorpera-agent-exit: not healthy: %s\n' "${problems[@]}" >&2
		return 1
	fi
	echo "qorpera-agent-exit: healthy"
}

status() {
	if ! has_ns; then
		echo "qorpera-agent-exit: down"
		return
	fi
	in_exit ip -o -4 addr show | awk '{print $2, $4}'
	echo "plugged in: $(plugged | tr '\n' ' ')"
	in_exit nft list counters table $EXIT_TABLE
	in_exit nft list set $EXIT_TABLE new_by_client
}

case "${1:-}" in
check)
	table_batch "$EXIT_TABLE" "$exit_rules" | nft -c -f /dev/stdin
	table_batch "$HOST_TABLE" "$host_rules" | nft -c -f /dev/stdin
	for tool in dnsmasq conntrack python3; do command -v "$tool" >/dev/null || die "missing $tool (packages: dnsmasq-base, conntrack, python3)"; done
	echo "qorpera-agent-exit: rules parse; tools present; $(has_ns && echo up || echo down)"
	;;
up) up ;;
down) down "${2:-}" ;;
dns) dns ;;
log) log ;;
verify) verify ;;
status) status ;;
*) usage ;;
esac
