#!/usr/bin/env bash
# Qorpera agent exit (E1, E2, E3, E8b, E8c): builds, checks or removes the exit on one node. Run as root.
#
#   qorpera-agent-exit.sh check     parse the three rule files against the kernel; change nothing
#   qorpera-agent-exit.sh up        create or repair, in place: rules first, then namespace links, addresses, routes
#   qorpera-agent-exit.sh down      remove all of it; refused while an agent road machine is plugged in (no override)
#   qorpera-agent-exit.sh dns       run dnsmasq in the exit, in the foreground (the dns unit)
#   qorpera-agent-exit.sh log       run the connection logger in the foreground (the log unit)
#   qorpera-agent-exit.sh plug      run the agent plug's reconciler in the foreground (the plug unit)
#   qorpera-agent-exit.sh names     run the names reconciler in the foreground (the names unit, E8b)
#   qorpera-agent-exit.sh resolver PORT   run one company's resolver in the exit, in the foreground (its unit, E8b)
#   qorpera-agent-exit.sh sni       run the server name checker in the exit, in the foreground (the sni unit, E8c-2)
#   qorpera-agent-exit.sh logs      tend the logs on the node once: seal, compress, count, keep under the cap (timer)
#   qorpera-agent-exit.sh ship      copy the sealed logs to the NAS once, each read back and compared (timer)
#   qorpera-agent-exit.sh verify    exit 0 only when every part is up, the logger is alive and the client map is true
#   qorpera-agent-exit.sh health    write verify's answer to <run-dir>/health.json for the node observer
#   qorpera-agent-exit.sh status    addresses, plugged-in machines and counters
#   qorpera-agent-exit.sh counts [--from DAY] [--to DAY] [--json]   the line guard's counts per company (E7)
#   qorpera-agent-exit.sh lookup --at TIME [--remote ADDR [--remote-port N]] [--agent ADDR] [--window S] [--days N]
#                   [--json]        who used an address (one or both), on every node: companies, machines, names
#   qorpera-agent-exit.sh database-url  the exit's database login (E8b) from stdin into its root-only file; prints the
#                   file's mode, owner, size and sha256, never the login (only the rollout script runs it)
#   qorpera-agent-exit.sh rules-start   enable and restart the rules reader; exit 0 once it has read the database
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
bridge_rules=${QORPERA_AGENT_EXIT_BRIDGE_RULES:-$here/qorpera-agent-exit-bridge.nft}
logger=${QORPERA_AGENT_EXIT_LOGGER:-$here/qorpera-agent-exit-log.py}
plug_tool=${QORPERA_AGENT_EXIT_PLUG:-$here/qorpera-agent-plug.py}
logs_tool=${QORPERA_AGENT_EXIT_LOGS:-$here/qorpera-agent-exit-logs.py}
names_tool=${QORPERA_AGENT_EXIT_NAMES:-$here/qorpera-agent-exit-names.py}
sni_tool=${QORPERA_AGENT_EXIT_SNI:-$here/qorpera-agent-exit-sni.py}
sni_rules=${QORPERA_AGENT_EXIT_SNI_RULES:-$here/qorpera-agent-exit-sni.nft}
upstreams=${QORPERA_AGENT_EXIT_UPSTREAMS:-9.9.9.9 1.1.1.1}
run_dir=${QORPERA_AGENT_EXIT_RUN_DIR:-/run/qorpera-agent-exit}
state_dir=${QORPERA_AGENT_EXIT_STATE_DIR:-/var/lib/qorpera-agent-exit}
log_dir=${QORPERA_AGENT_EXIT_LOG_DIR:-/var/log/qorpera-agent-exit}
# The exit's database login (E8b): root's alone; the rules reader gets it as a systemd credential.
login_dir=${QORPERA_AGENT_EXIT_LOGIN_DIR:-/etc/qorpera-agent-exit}
rules_unit=qorpera-agent-exit-rules.service
rules_status=${QORPERA_AGENT_EXIT_RULES_STATUS:-/run/qorpera-agent-exit-rules/status.json}
# The companies' network rules as the rules reader writes them (root's alone; the names reconciler reads them).
network_rules=${QORPERA_AGENT_EXIT_NETWORK_RULES:-$state_dir/rules/rules.json}
# The logs may hold at most this many bytes of the node's disk, and leave at least this share of it free. A node may
# set its own in /etc/default/qorpera-agent-exit, its NAS folder (E3) and the brake's levels (E7): KEY=number lines for
# the numbers, KEY=/absolute/path for the folder, and the levels as written (the logger says what is wrong with one);
# nothing else is read from it.
settings=${QORPERA_AGENT_EXIT_SETTINGS:-/etc/default/qorpera-agent-exit}
setting() {
	[[ -r $settings ]] || return 0
	sed -n "s/^$1=\([0-9][0-9.]*\)\$/\1/p" "$settings" | tail -1
}
path_setting() {
	[[ -r $settings ]] || return 0
	sed -n "s|^$1=\(/[A-Za-z0-9/._-]*\)\$|\1|p" "$settings" | tail -1
}
log_cap=${QORPERA_AGENT_EXIT_LOG_CAP_BYTES:-$(setting QORPERA_AGENT_EXIT_LOG_CAP_BYTES)}
log_cap=${log_cap:-2147483648}
log_floor=${QORPERA_AGENT_EXIT_LOG_FLOOR_PERCENT:-$(setting QORPERA_AGENT_EXIT_LOG_FLOOR_PERCENT)}
log_floor=${log_floor:-10}
# The NAS folder the logs go to (README.md, "The logs on the NAS"); empty: none, and `verify` fails.
nas_dir=${QORPERA_AGENT_EXIT_NAS_DIR-$(path_setting QORPERA_AGENT_EXIT_NAS_DIR)}
brake_setting() {
	[[ -r $settings ]] || return 0
	sed -n "s/^$1=\(.*\)\$/\1/p" "$settings" | tail -1
}
# The brake's levels (README.md, "The brake"); none set: the brake is off.
brake_new=${QORPERA_AGENT_EXIT_BRAKE_NEW_10S-$(brake_setting QORPERA_AGENT_EXIT_BRAKE_NEW_10S)}
brake_failed=${QORPERA_AGENT_EXIT_BRAKE_FAILED_60S-$(brake_setting QORPERA_AGENT_EXIT_BRAKE_FAILED_60S)}
brake_slow=${QORPERA_AGENT_EXIT_BRAKE_SLOW_10S-$(brake_setting QORPERA_AGENT_EXIT_BRAKE_SLOW_10S)}
brake_minutes=${QORPERA_AGENT_EXIT_BRAKE_MINUTES-$(brake_setting QORPERA_AGENT_EXIT_BRAKE_MINUTES)}

NS=qexit
BRIDGE=qagent0
GATEWAY=10.210.0.1
AGENTS=10.210.0.0/16
UP_NODE=10.209.255.1
UP_EXIT=10.209.255.2
EXIT_TABLE="inet qorpera_agent_exit"
HOST_TABLE="inet qorpera_agent_exit_host"
BRIDGE_TABLE="bridge qorpera_agent_exit_bridge"
# Leases are short so an address the agent plug quarantines (15 minutes) is free again before it is reused.
LEASE=10m
# Machine creators in this group may plug machines in (qorpera-agent-plug.py plug); everyone else only reads.
PLUG_GROUP=qorpera-agent-plug

usage() {
	sed -n '4,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
	exit 64
}

die() {
	echo "qorpera-agent-exit: $*" >&2
	exit 1
}

in_exit() { ip netns exec "$NS" "$@"; }
has_ns() { [[ -e /run/netns/$NS ]]; }
has_link() { ip link show dev "$1" >/dev/null 2>&1; }
# True when this process already runs in the exit's namespace (a unit with NetworkNamespacePath=).
inside_exit() { has_ns && [[ $(stat -L -c %i /proc/self/ns/net) == $(stat -L -c %i "/run/netns/$NS") ]]; }
# The server name check (E8c-2) runs only while the kernel has both queue modules loaded. The exit never loads them, and
# never makes the kernel load them: a queue rule would load nft_queue, the checker's queue socket nfnetlink_queue.
queue_loaded() { [[ -d /sys/module/nft_queue && -d /sys/module/nfnetlink_queue ]]; }

# One nft batch per table: create it if missing, delete it, define it again. The kernel applies all or none.
table_batch() {
	local table=$1 file=$2
	[[ -r $file ]] || die "cannot read $file"
	grep -q "^table $table {\$" "$file" || die "$file does not define table $table"
	printf 'table %s\ndelete table %s\n' "$table" "$table"
	cat -- "$file" || die "cannot read $file"
}

# The bridge rules come with their sets filled from the client map, in the same transaction: a reload never leaves
# a plugged machine without its address for a moment.
bridge_batch() {
	local elements
	elements=$(python3 "$plug_tool" elements --state-dir "$state_dir" --run-dir "$run_dir" --log-dir "$log_dir") ||
		die "cannot read the client map"
	table_batch "$BRIDGE_TABLE" "$bridge_rules"
	[[ -z $elements ]] || printf '%s\n' "$elements"
}

# The exit's rules likewise come with the names map filled (E8b): a reload never takes a machine's DNS away.
exit_batch() {
	local elements
	elements=$(python3 "$names_tool" elements --state-dir "$state_dir" --run-dir "$run_dir" --rules "$network_rules") ||
		die "cannot read the names map"
	table_batch "$EXIT_TABLE" "$exit_rules"
	[[ -z $elements ]] || printf '%s\n' "$elements"
	# The sni chain (E8c-2) in the same transaction, while the queue modules are loaded; without them "only listed" goes
	# by address alone.
	if queue_loaded; then cat -- "$sni_rules" || die "cannot read $sni_rules"; fi
}

load_tables() {
	local exit_text host_text bridge_text
	exit_text=$(exit_batch)
	host_text=$(table_batch "$HOST_TABLE" "$host_rules")
	bridge_text=$(bridge_batch)
	in_exit nft -c -f /dev/stdin <<<"$exit_text"
	nft -c -f /dev/stdin <<<"$host_text"
	nft -c -f /dev/stdin <<<"$bridge_text"
	in_exit nft -f /dev/stdin <<<"$exit_text"
	nft -f /dev/stdin <<<"$host_text"
	nft -f /dev/stdin <<<"$bridge_text"
}

# The node never routes into or out of the agents' bridge, never answers ARP there, and has no IPv6 on the exit's
# links. Set on every up, not only when a link is created.
host_link_settings() {
	sysctl -qw "net.ipv4.conf.$BRIDGE.forwarding=0" "net.ipv4.conf.$BRIDGE.rp_filter=1" \
		"net.ipv4.conf.$BRIDGE.arp_ignore=8" "net.ipv6.conf.$BRIDGE.disable_ipv6=1" \
		net.ipv6.conf.qx-br.disable_ipv6=1 net.ipv6.conf.qx-up.disable_ipv6=1 net.ipv4.conf.qx-up.rp_filter=1
}

# The client map and the leases: creators in the plug group add files (setgid keeps the group, the sticky bit keeps
# one creator from removing another's); only the reconciler, as root, removes them. dnsmasq reads the leases.
state_dirs() {
	install -d -m 0755 "$run_dir" "$state_dir" "$state_dir/quarantine" "$state_dir/seen" "$state_dir/verified" \
		"$run_dir/plug-stopped" "$run_dir/plug-missing" "$run_dir/plug-unflushed" "$run_dir/plug-noted"
	install -d -m 0750 "$log_dir"
	local dir
	for dir in "$state_dir/clients" "$state_dir/dhcp-hosts"; do
		if getent group "$PLUG_GROUP" >/dev/null; then
			install -d -m 3775 -g "$PLUG_GROUP" "$dir"
		else
			install -d -m 0755 "$dir"
		fi
	done
	[[ -e $state_dir/plug.lock ]] || install -m 0644 /dev/null "$state_dir/plug.lock"
}

# Client map entries: every machine plugged in, running or asleep (a sleeping machine has no port on the bridge).
clients() {
	find "$state_dir/clients" -maxdepth 1 -name '*.json' -printf '%f\n' 2>/dev/null | sed 's/\.json$//' | sort -V || true
}

# The network namespace of a running unit's main process, or nothing.
unit_netns() {
	local pid
	pid=$(systemctl show -p MainPID --value "$1" 2>/dev/null || true)
	[[ -n $pid && $pid != 0 ]] && stat -L -c %i "/proc/$pid/ns/net" 2>/dev/null || true
}

up() {
	state_dirs
	# The exit starts before LXD, which would otherwise turn forwarding on. Turning it on resets every interface's own
	# forwarding to 1, so the agents' bridge is set back to 0 below, after it.
	[[ $(cat /proc/sys/net/ipv4/ip_forward) == 1 ]] || sysctl -qw net.ipv4.ip_forward=1
	has_ns || ip netns add "$NS"
	in_exit sysctl -qw net.ipv4.ip_forward=1 net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1
	# Rules first: links, addresses and routes come up only behind them.
	load_tables
	in_exit sysctl -qw net.netfilter.nf_conntrack_acct=1
	has_link "$BRIDGE" || ip link add "$BRIDGE" type bridge
	# LLDP frames (01:80:c2:00:00:0e) would otherwise skip every bridge hook and reach the node's own stack on the
	# machine's port device: forward them, so the bridge rules judge them like any other frame.
	ip link set "$BRIDGE" type bridge group_fwd_mask 0x4000 no_linklocal_learn 1 stp_state 0
	# A qx-br or qx-up whose peer is not in this namespace (left from an earlier one) is replaced, and the name and
	# log services, which may still run in the old namespace, are restarted into the new one.
	local rebuilt=0
	if has_link qx-br && ! in_exit ip link show br0 >/dev/null 2>&1; then
		ip link del qx-br
		rebuilt=1
	fi
	has_link qx-br || ip link add qx-br type veth peer name br0 netns "$NS"
	if has_link qx-up && ! in_exit ip link show up0 >/dev/null 2>&1; then
		ip link del qx-up
		rebuilt=1
	fi
	has_link qx-up || ip link add qx-up type veth peer name up0 netns "$NS"
	host_link_settings
	ip link set qx-br master "$BRIDGE"
	in_exit ip link set lo up
	in_exit ip addr replace "$GATEWAY/16" dev br0
	ip addr replace "$UP_NODE/30" dev qx-up
	in_exit ip addr replace "$UP_EXIT/30" dev up0
	ip link set "$BRIDGE" up
	ip link set qx-br up
	ip link set qx-up up
	in_exit ip link set br0 up
	in_exit ip link set up0 up
	in_exit ip route replace default via "$UP_NODE" dev up0
	if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
		# The name service and the companies' resolvers live in the namespace they started in. If that is not this one
		# (a rebuild now, or one an earlier, interrupted up made), they restart into this one. The logger checks its own
		# reader (it exits when its reader watches an old namespace, and its unit restarts it).
		local ns dns_ns unit
		ns=$(stat -L -c %i "/run/netns/$NS")
		dns_ns=$(unit_netns qorpera-agent-exit-dns.service)
		if ((rebuilt)) || [[ -n $dns_ns && $dns_ns != "$ns" ]]; then
			systemctl try-restart --no-block qorpera-agent-exit-dns.service || true
		fi
		for unit in $(resolver_units); do
			dns_ns=$(unit_netns "$unit")
			if ((rebuilt)) || [[ -n $dns_ns && $dns_ns != "$ns" ]]; then
				systemctl try-restart --no-block "$unit" || true
			fi
		done
		((rebuilt)) && { systemctl try-restart --no-block qorpera-agent-exit-log.service || true; }
		# The server name checker (E8c-2) leaves an old namespace by itself, and its unit starts it again. While the queue
		# modules are loaded the sni chain is in the rules, so it starts here too (modules loaded after the exit came up).
		if queue_loaded; then systemctl start --no-block qorpera-agent-exit-sni.service || true; fi
	fi
	echo "qorpera-agent-exit: up"
}

# The companies' resolver units systemd has loaded (E8b).
resolver_units() {
	systemctl list-units --all --plain --no-legend --full 'qorpera-agent-exit-resolver@*.service' 2>/dev/null |
		grep -o 'qorpera-agent-exit-resolver@[0-9]*\.service' || true
}

plugged() { ip -o link show master "$BRIDGE" 2>/dev/null | awk -F': ' '{print $2}' | cut -d@ -f1 | grep -vx qx-br || true; }

down() {
	local machines pid
	machines=$(clients)
	[[ -z $machines ]] ||
		die "agent road machines are plugged in, running or asleep (client map: $(echo "$machines" | tr '\n' ' ')); the exit stays up"
	if has_link "$BRIDGE"; then
		machines=$(plugged)
		[[ -z $machines ]] || die "agent road machines are plugged in ($(echo "$machines" | tr '\n' ' ')); the exit stays up"
	fi
	if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
		systemctl stop --no-block qorpera-agent-exit-dns.service qorpera-agent-exit-log.service qorpera-agent-plug.service \
			qorpera-agent-exit-names.service 'qorpera-agent-exit-resolver@*.service' qorpera-agent-exit-sni.service \
			2>/dev/null || true
	fi
	if has_ns; then
		for pid in $(ip netns pids "$NS"); do kill "$pid" 2>/dev/null || true; done
		for _ in $(seq 1 25); do [[ -z $(ip netns pids "$NS") ]] && break; sleep 0.2; done
		for pid in $(ip netns pids "$NS"); do kill -9 "$pid" 2>/dev/null || true; done
	fi
	if has_ns; then ip netns del "$NS"; fi
	# The veths go with the namespace, a moment after it: wait for them, and never stop half way on one that vanished
	# between the check and the delete (the bridge and the node's rules would stay).
	for link in qx-br qx-up; do
		for _ in $(seq 1 25); do has_link "$link" || break; sleep 0.2; done
		if has_link "$link"; then ip link del "$link" 2>/dev/null || ! has_link "$link" || die "cannot remove $link"; fi
	done
	if has_link "$BRIDGE"; then ip link del "$BRIDGE"; fi
	# The node's rules go last, after the links they guard.
	if nft list table $HOST_TABLE >/dev/null 2>&1; then nft delete table $HOST_TABLE; fi
	if nft list table $BRIDGE_TABLE >/dev/null 2>&1; then nft delete table $BRIDGE_TABLE; fi
	echo "qorpera-agent-exit: down"
}

dns() {
	local args=() server
	has_ns || die "the exit is not up"
	for server in $upstreams; do args+=("--server=$server"); done
	# Static leases only: the agent plug (E2) writes one "mac,address" file per machine into dhcp-hosts and sends
	# SIGHUP (the dns unit's reload) when it removes one. Machines' own names are ignored and never published, and so
	# are their client ids: a lease is the MAC's alone, so no machine can reach another's lease by naming its id.
	local command=(dnsmasq --keep-in-foreground --conf-file=/dev/null --pid-file=
		--no-resolv --no-hosts --no-poll --bind-interfaces --interface=br0 --listen-address="$GATEWAY"
		"${args[@]}"
		--dhcp-range="${AGENTS%/*},static,255.255.0.0,$LEASE" --dhcp-authoritative --dhcp-ignore-names
		--dhcp-ignore-clid
		--dhcp-hostsdir="$state_dir/dhcp-hosts" --dhcp-leasefile="$run_dir/dnsmasq.leases"
		--dhcp-option=option:router,"$GATEWAY" --dhcp-option=option:dns-server,"$GATEWAY"
		--log-queries=extra --log-facility="$log_dir/dns.log" --log-async=50)
	# dnsmasq stamps its log lines with the local time and no zone: UTC, whatever the node's zone, as the lookup reads
	# them.
	export TZ=UTC
	if inside_exit; then exec "${command[@]}"; else exec ip netns exec "$NS" "${command[@]}"; fi
}

# The server name checker (E8c-2): reads queue 0 in the exit, where the sni chain sends the packets of each only-listed
# port 443 flow until its ClientHello is judged. Without the queue modules it says so and ends (its unit does not even
# start then); it never loads them.
sni() {
	has_ns || die "the exit is not up"
	local command=(python3 "$sni_tool" check --state-dir "$state_dir" --run-dir "$run_dir" --rules "$network_rules"
		--netns-path "/run/netns/$NS")
	if inside_exit; then exec "${command[@]}"; else exec ip netns exec "$NS" "${command[@]}"; fi
}

# One company's resolver (E8b): answers "no such name" for its blocked names (the servers file the names reconciler
# writes) and asks the upstreams for every other. No DHCP, no leases: the main dnsmasq keeps those. It logs to the same
# file as the main one (each writes whole lines, appending). Without its servers file it does not start: dnsmasq would
# run with no list at all. In "only listed" mode (E8c, the mode file says so) the servers file names the upstreams for
# each allowed name and answers every other itself, so it gets no upstreams of its own, and it puts each address it
# gives out for an allowed name in the company's set allow_<port>, which its machines' chain only_<port> lets through.
resolver() {
	local port=$1 args=() server servers mode=open
	[[ $port =~ ^[1-9][0-9]{4}$ ]] && ((port >= 10001 && port <= 19999)) || die "resolver: not a resolver port: $port"
	has_ns || die "the exit is not up"
	servers="$run_dir/names/$port.servers"
	[[ -f $servers && ! -L $servers ]] || die "resolver: no servers file $servers"
	if [[ -e $run_dir/names/$port.mode ]]; then
		[[ -f $run_dir/names/$port.mode && ! -L $run_dir/names/$port.mode ]] || die "resolver: bad mode file"
		mode=$(<"$run_dir/names/$port.mode")
	fi
	case $mode in
	open) for server in $upstreams; do args+=("--server=$server"); done ;;
	only-listed) args+=("--nftset=/#/4#inet#qorpera_agent_exit#allow_$port") ;;
	*) die "resolver: bad mode in $run_dir/names/$port.mode" ;;
	esac
	local command=(dnsmasq --keep-in-foreground --conf-file=/dev/null --pid-file=
		--no-resolv --no-hosts --no-poll --bind-interfaces --listen-address="$GATEWAY" --port="$port"
		"${args[@]}" --servers-file="$servers"
		--log-queries=extra --log-facility="$log_dir/dns.log" --log-async=50)
	export TZ=UTC
	if inside_exit; then exec "${command[@]}"; else exec ip netns exec "$NS" "${command[@]}"; fi
}

log() {
	has_ns || die "the exit is not up"
	install -d -m 0750 "$log_dir"
	install -d -m 0755 "$run_dir"
	# The brake's levels go with "=": one that looks like an option is a bad level (verify says so), not a logger that
	# cannot start.
	exec python3 "$logger" --netns "$NS" --log-dir "$log_dir" --heartbeat "$run_dir/logger.heartbeat" \
		--pause-file "$run_dir/logger.pause" --failing-file "$run_dir/logger.failing" --cap-bytes "$log_cap" \
		--floor-percent "$log_floor" --state-dir "$state_dir" --brake-status "$run_dir/brake.json" \
		--brake-new-10s="$brake_new" --brake-failed-60s="$brake_failed" --brake-slow-10s="$brake_slow" \
		--brake-minutes="$brake_minutes"
}

logs() {
	install -d -m 0750 "$log_dir"
	install -d -m 0755 "$run_dir"
	exec python3 "$logs_tool" tend --log-dir "$log_dir" --status "$run_dir/logs.json" --cap-bytes "$log_cap" \
		--floor-percent "$log_floor"
}

ship() {
	install -d -m 0750 "$log_dir"
	install -d -m 0755 "$run_dir"
	exec python3 "$logs_tool" ship --log-dir "$log_dir" --nas-dir "$nas_dir" --status "$run_dir/ship.json"
}

plug() {
	state_dirs
	exec python3 "$plug_tool" reconcile --netns "$NS" --state-dir "$state_dir" --run-dir "$run_dir" --log-dir "$log_dir"
}

names() {
	state_dirs
	install -d -m 0755 "$state_dir/names" "$run_dir/names"
	exec python3 "$names_tool" reconcile --netns "$NS" --state-dir "$state_dir" --run-dir "$run_dir" \
		--rules "$network_rules" --rules-status "$rules_status" --upstreams "$upstreams"
}

verify() {
	local problems=() heartbeat age setting ns listing
	has_ns || problems+=("no namespace $NS")
	has_link "$BRIDGE" || problems+=("no bridge $BRIDGE")
	if has_link "$BRIDGE"; then
		for setting in forwarding=0 arp_ignore=8; do
			[[ $(cat "/proc/sys/net/ipv4/conf/$BRIDGE/${setting%=*}") == "${setting#*=}" ]] ||
				problems+=("$BRIDGE ${setting%=*} is not ${setting#*=}")
		done
		# Ubuntu's sysctl.d sets rp_filter=2 on every interface (and on "all", which wins); either filter is fine.
		[[ $(cat "/proc/sys/net/ipv4/conf/$BRIDGE/rp_filter") != 0 ]] || problems+=("$BRIDGE rp_filter is off")
		[[ $(cat "/sys/class/net/$BRIDGE/bridge/group_fwd_mask") == 0x4000 ]] ||
			problems+=("$BRIDGE does not forward LLDP frames through its rules")
		[[ $(cat "/sys/class/net/$BRIDGE/bridge/no_linklocal_learn") == 1 ]] ||
			problems+=("$BRIDGE learns MACs from link-local frames")
		[[ $(cat "/sys/class/net/$BRIDGE/bridge/stp_state") == 0 ]] || problems+=("$BRIDGE runs STP")
	fi
	if has_ns; then
		# Each listing is read whole before it is searched: piped into grep -q, a command still writing after the match
		# dies of SIGPIPE, and pipefail would report the line missing (ss lists every company's resolver too).
		listing=$(in_exit ip -o -4 addr show dev br0 2>/dev/null || true)
		[[ $listing == *" $GATEWAY/16 "* ]] || problems+=("br0 lacks $GATEWAY/16")
		listing=$(in_exit ip -o -4 addr show dev up0 2>/dev/null || true)
		[[ $listing == *" $UP_EXIT/30 "* ]] || problems+=("up0 lacks $UP_EXIT/30")
		listing=$(in_exit ip route show default 2>/dev/null || true)
		[[ $listing == *"via $UP_NODE "* ]] || problems+=("no default route via $UP_NODE")
		in_exit nft list table $EXIT_TABLE >/dev/null 2>&1 || problems+=("exit rules not loaded")
		listing=$(in_exit ss -lnu 2>/dev/null || true)
		[[ $listing == *"$GATEWAY:53 "* ]] || problems+=("no DNS on $GATEWAY:53")
		ns=$(stat -L -c %i "/run/netns/$NS")
		[[ -z $(unit_netns qorpera-agent-exit-dns.service) || $(unit_netns qorpera-agent-exit-dns.service) == "$ns" ]] ||
			problems+=("the name service runs in an old namespace")
	fi
	nft list table $HOST_TABLE >/dev/null 2>&1 || problems+=("node rules not loaded")
	nft list table $BRIDGE_TABLE >/dev/null 2>&1 || problems+=("bridge rules not loaded")
	heartbeat="$run_dir/logger.heartbeat"
	if [[ -e $heartbeat ]]; then
		age=$(($(date +%s) - $(stat -c %Y "$heartbeat")))
		((age < 30)) || problems+=("logger silent for ${age}s")
	else
		problems+=("logger not running")
	fi
	# The logger pauses rather than fill the node's disk; the logs' tender keeps them under their cap.
	[[ ! -e $run_dir/logger.pause ]] || problems+=("connection log paused: $(head -c 300 "$run_dir/logger.pause")")
	[[ ! -e $run_dir/logger.failing ]] || problems+=("$(head -c 300 "$run_dir/logger.failing")")
	local logs_status="$run_dir/logs.json"
	if [[ -e $logs_status ]]; then
		age=$(($(date +%s) - $(stat -c %Y "$logs_status")))
		((age < 900)) || problems+=("the logs' tender has not run for ${age}s")
		while IFS= read -r problem; do
			[[ -z $problem ]] || problems+=("the logs' tender: $problem")
		done < <(python3 -c 'import json, sys; print("\n".join(json.load(open(sys.argv[1]))["problems"]))' \
			"$logs_status" 2>/dev/null || echo "cannot read $logs_status")
	else
		problems+=("the logs' tender has not run")
	fi
	# The logs' shipper (E3): alive (a long pass writes its status every minute), a NAS folder set, nothing waiting
	# more than a day.
	local ship_status="$run_dir/ship.json"
	if [[ -e $ship_status ]]; then
		age=$(($(date +%s) - $(stat -c %Y "$ship_status")))
		((age < 1800)) || problems+=("the logs' shipper has not run for ${age}s")
		while IFS= read -r problem; do
			[[ -z $problem ]] || problems+=("the logs' shipper: $problem")
		done < <(python3 -c 'import json, sys; print("\n".join(json.load(open(sys.argv[1]))["problems"]))' \
			"$ship_status" 2>/dev/null || echo "cannot read $ship_status")
	else
		problems+=("the logs' shipper has not run")
	fi
	# The brake (E7): the logger's guard alive (it writes its status every 2 seconds), its levels well formed, and the
	# exit's brake rules readable and as it decided.
	local brake_status="$run_dir/brake.json"
	if [[ -e $brake_status ]]; then
		age=$(($(date +%s) - $(stat -c %Y "$brake_status")))
		((age < 30)) || problems+=("the brake silent for ${age}s")
		while IFS= read -r problem; do
			[[ -z $problem ]] || problems+=("the brake: $problem")
		done < <(python3 -c 'import json, sys; print("\n".join(json.load(open(sys.argv[1]))["problems"]))' \
			"$brake_status" 2>/dev/null || echo "cannot read $brake_status")
	else
		problems+=("the brake not running")
	fi
	# The agent plug's reconciler: alive, and the client map true to LXD (qorpera-agent-plug.py).
	local plug_status="$run_dir/plug.json" problem
	if [[ -e $plug_status ]]; then
		age=$(($(date +%s) - $(stat -c %Y "$plug_status")))
		((age < 30)) || problems+=("the agent plug's reconciler silent for ${age}s")
		while IFS= read -r problem; do
			[[ -z $problem ]] || problems+=("$problem")
		done < <(python3 -c 'import json, sys; print("\n".join(json.load(open(sys.argv[1]))["problems"]))' \
			"$plug_status" 2>/dev/null || echo "cannot read $plug_status")
	else
		problems+=("the agent plug's reconciler not running")
	fi
	# The names reconciler (E8b): alive, the rules reader alive and not failing long, every company's rules usable,
	# every resolver answering and the DNS map as the client map and the rules say (qorpera-agent-exit-names.py).
	local names_status="$run_dir/names.json"
	if [[ -e $names_status ]]; then
		age=$(($(date +%s) - $(stat -c %Y "$names_status")))
		((age < 30)) || problems+=("the names reconciler silent for ${age}s")
		while IFS= read -r problem; do
			[[ -z $problem ]] || problems+=("names: $problem")
		done < <(python3 -c 'import json, sys; print("\n".join(json.load(open(sys.argv[1]))["problems"]))' \
			"$names_status" 2>/dev/null || echo "cannot read $names_status")
	else
		problems+=("the names reconciler not running")
	fi
	# The server name checker (E8c-2), while the queue modules are loaded: the sni chain in the rules, queue 0 bound in
	# the exit (its row in nfnetlink_queue) and the checker alive. Without the modules "only listed" goes by address
	# alone, which is no problem here.
	if queue_loaded; then
		in_exit nft list chain inet qorpera_agent_exit sni >/dev/null 2>&1 ||
			problems+=("the sni chain is not in the rules (the queue modules came after the rules: reload the exit)")
		in_exit awk '$1 == 0 { found = 1 } END { exit !found }' /proc/net/netfilter/nfnetlink_queue 2>/dev/null ||
			problems+=("no server name checker on queue 0: only-listed port 443 flows are refused")
		local sni_status="$run_dir/sni.json"
		if [[ -e $sni_status ]]; then
			age=$(($(date +%s) - $(stat -c %Y "$sni_status")))
			((age < 30)) || problems+=("the server name checker silent for ${age}s")
			while IFS= read -r problem; do
				[[ -z $problem ]] || problems+=("sni: $problem")
			done < <(python3 -c 'import json, sys; print("\n".join(json.load(open(sys.argv[1]))["problems"]))' \
				"$sni_status" 2>/dev/null || echo "cannot read $sni_status")
		else
			problems+=("the server name checker not running")
		fi
	fi
	if ((${#problems[@]} > 0)); then
		printf 'qorpera-agent-exit: not healthy: %s\n' "${problems[@]}" >&2
		return 1
	fi
	echo "qorpera-agent-exit: healthy"
}

# verify's answer as JSON for the node observer, which has no capabilities and cannot run verify itself.
health() {
	local report healthy=true
	report=$(verify 2>&1) || healthy=false
	install -d -m 0755 "$run_dir"
	HEALTH_REPORT=$report python3 -c '
import json, os, sys, time
problems = [line.removeprefix("qorpera-agent-exit: not healthy: ") for line in os.environ["HEALTH_REPORT"].splitlines()
            if line.startswith("qorpera-agent-exit: not healthy: ")]
record = {"schema": "qorpera.agent-exit-health/v1", "healthy": sys.argv[2] == "true",
          "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "problems": problems}
tmp = sys.argv[1] + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(record, f, sort_keys=True)
    f.write("\n")
os.chmod(tmp, 0o644)
os.replace(tmp, sys.argv[1])
' "$run_dir/health.json" "$healthy"
	[[ $healthy == true ]]
}

status() {
	if ! has_ns; then
		echo "qorpera-agent-exit: down"
		return
	fi
	in_exit ip -o -4 addr show | awk '{print $2, $4}'
	echo "ports on $BRIDGE: $(plugged | tr '\n' ' ')"
	echo "client map (running or asleep): $(clients | tr '\n' ' ')"
	in_exit nft list counters table $EXIT_TABLE
	in_exit nft list set $EXIT_TABLE new_by_client
	in_exit nft list set $EXIT_TABLE refused_by_client
	# The brake (E7): the machines braked now (with their company's number) and each number's dropped connections.
	in_exit nft list map $EXIT_TABLE braked
	in_exit nft list set $EXIT_TABLE dropped
	[[ ! -e $run_dir/brake.json ]] || cat "$run_dir/brake.json"
	# Each company's names (E8b): which resolver port each machine's DNS goes to.
	in_exit nft list map $EXIT_TABLE dns_port
}

# The exit's database login (E8b), from stdin. Only the rollout script (rules-reader-login.py) runs this, through ssh
# and the root helper, so the login is never an argument, in a log or in a shell's history. It is written all at once,
# root-only (0400) and without a newline, so the printed sha256 is the login's own for the script to compare. A login
# not in the one form the script makes is refused, and the old file stays.
login_tmp=
database_url() {
	local url pattern file="$login_dir/database-url"
	pattern='^postgresql://qorpera_agent_exit(\.[a-z0-9]{20})?:[A-Za-z0-9_-]{20,128}'
	pattern+='@[a-z0-9.-]{1,253}:[0-9]{1,5}/postgres\?sslmode=verify-full$'
	url=$(head -c 4097)
	((${#url} <= 4096)) && [[ $url =~ $pattern ]] ||
		die "database-url: refused, not a login as the rollout script makes it"
	install -d -m 0700 -o root -g root "$login_dir"
	login_tmp=$(mktemp "$login_dir/.database-url.XXXXXX")
	trap 'rm -f -- "$login_tmp"' EXIT
	printf '%s' "$url" >"$login_tmp"
	url=
	chmod 0400 "$login_tmp"
	chown root:root "$login_tmp"
	sync -- "$login_tmp"
	mv -fT -- "$login_tmp" "$file"
	trap - EXIT
	sync -- "$login_dir"
	echo "$(stat -c '%n mode=%a owner=%U:%G bytes=%s' "$file") sha256=$(sha256sum <"$file" | cut -d' ' -f1)"
}

# After the login changed (rules-reader-login.py runs this): enable the rules reader and restart it, so it reads the
# new login, and wait up to 30 seconds for a pass that read the database. A restart empties its runtime folder, so the
# status read here is the new run's. Prints ok, or the reader's problem code; never the login.
rules_start() {
	local i answer last=
	systemctl reset-failed "$rules_unit" 2>/dev/null || true
	systemctl enable --quiet "$rules_unit"
	systemctl restart "$rules_unit"
	for ((i = 0; i < 30; i++)); do
		sleep 1
		answer=$(python3 -c '
import json, re, sys
try:
    with open(sys.argv[1], encoding="utf-8") as f:
        status = json.load(f)
except (OSError, ValueError):
    print("waiting")
    sys.exit()
problem = status.get("problem")
code = " " + problem if isinstance(problem, str) and re.fullmatch(r"[A-Z0-9_]{1,32}", problem) else ""
print(("read" if isinstance(status.get("readAt"), str) else "waiting") + code)
' "$rules_status")
		case $answer in
		read)
			echo "qorpera-agent-exit: the rules reader read the database: ok"
			return 0
			;;
		read\ *)
			echo "qorpera-agent-exit: the rules reader read the database: ok (problem ${answer#read })"
			return 0
			;;
		esac
		last=${answer#waiting}
	done
	systemctl is-active --quiet "$rules_unit" || die "the rules reader is not running (journalctl -u $rules_unit)"
	die "the rules reader has not read the database in 30 s${last:+ (problem${last})}"
}

case "${1:-}" in
check)
	# The sni chain only with the queue modules loaded: its queue rule would make the kernel load nft_queue (E8c-2).
	[[ -r $sni_rules ]] || die "cannot read $sni_rules"
	if queue_loaded; then
		{ table_batch "$EXIT_TABLE" "$exit_rules"; cat -- "$sni_rules"; } | nft -c -f /dev/stdin
	else
		table_batch "$EXIT_TABLE" "$exit_rules" | nft -c -f /dev/stdin
	fi
	table_batch "$HOST_TABLE" "$host_rules" | nft -c -f /dev/stdin
	table_batch "$BRIDGE_TABLE" "$bridge_rules" | nft -c -f /dev/stdin
	python3 -c 'import ast, sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]' "$logger" "$plug_tool" \
		"$logs_tool" "$names_tool" "$sni_tool" ||
		die "the logger, the plug tool, the logs' tender, the names tool or the server name checker does not parse"
	for tool in dnsmasq conntrack python3; do command -v "$tool" >/dev/null || die "missing $tool (packages: dnsmasq-base, conntrack, python3)"; done
	echo "qorpera-agent-exit: rules parse; tools present; $(has_ns && echo up || echo down);" \
		"$(queue_loaded && echo "server names checked" || echo "only listed by address alone (no queue modules)")"
	;;
up) up ;;
down) down ;;
dns) dns ;;
log) log ;;
plug) plug ;;
names) names ;;
sni) sni ;;
resolver) resolver "${2:-}" ;;
logs) logs ;;
ship) ship ;;
counts) exec python3 "$logs_tool" report --log-dir "$log_dir" "${@:2}" ;;
lookup)
	exec python3 "$logs_tool" lookup --log-dir "$log_dir" --nas-dir "$nas_dir" --heartbeat "$run_dir/logger.heartbeat" \
		--pause-file "$run_dir/logger.pause" --failing-file "$run_dir/logger.failing" "${@:2}"
	;;
verify) verify ;;
health) health ;;
status) status ;;
database-url) database_url ;;
rules-start) rules_start ;;
*) usage ;;
esac
