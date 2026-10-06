#!/usr/bin/env bash
# The agent plug on a real LXD (E2b), inside the throwaway VM test/prove-lxd-vm.sh makes (never on a node, never on a
# shared test machine: it loads br_netfilter and changes this kernel's tables). It builds the exit with the real tool,
# rules and plug tool, plugs real LXD containers into qagent0 the way the creators will (plug right before the create,
# then the card plug gave), and checks what the Docker proof cannot:
# - LXD's MAC and IPv6 filters and port isolation, with the exit's bridge rules, against spoofing from a plugged port
#   (another address, another MAC, gratuitous ARP for another machine, DHCP naming another machine, MAC theft);
# - default deny until the reconciler has a machine in the bridge rules, and the rules set right after a reconciler
#   crash, a hand flush and an `up` reload;
# - the reconciler against LXD's real API (sleep, delete, a stray card);
# - br_netfilter with the node's notrack, and the connection tables under floods (TCP open and close, unanswered
#   SYNs, refused SYNs, UDP, another protocol, spoofed sources, IPv6), with and without notrack, and the shared
#   total's cost. Floods go only to a stand-in internet in this VM (TEST-NET-2) and to refused addresses.
# Prints PASS lines, then one JSON line "RESULT {...}", then ALL PASSED.
set -euo pipefail

here=${QORPERA_AGENT_EXIT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
tool="$here/qorpera-agent-exit.sh"
plug_tool="$here/qorpera-agent-plug.py"
PROJECT=qae2b
POOL=qae2b
IMAGE=${QORPERA_AGENT_EXIT_PROOF_IMAGE:-qae2b-ct}
FLOOD=${QORPERA_AGENT_EXIT_PROOF_FLOOD:-20000}

fail() {
	echo "FAIL: $*" >&2
	diagnose >&2 || true
	exit 1
}
pass() { echo "PASS: $*"; }
wait_for() {
	local i
	for i in $(seq 1 "${2:-150}"); do
		if eval "$1"; then return 0; fi
		sleep 0.2
	done
	fail "timed out waiting for: $1"
}
lx() { lxc --project "$PROJECT" "$@" </dev/null; }
in_m() {
	local m=$1
	shift
	lxc --project "$PROJECT" exec "$m" -- "$@" </dev/null
}
reach() { in_m "$1" timeout 4 python3 -c 'import socket, sys; socket.create_connection((sys.argv[1], int(sys.argv[2])), 3)' "$2" "$3" 2>/dev/null; }
lease_of() { in_m "$1" ip -4 -o addr show dev eth0 2>/dev/null | awk '{print $4}' | cut -d/ -f1; }
diagnose() {
	[[ -n ${work:-} && -d ${work:-/nonexistent} ]] || return 0
	echo "--- dns.log"; tail -n 20 "$work/log/dns.log" 2>/dev/null
	echo "--- plug"; cat "$work/run/plug.json" 2>/dev/null; tail -n 5 "$work/plug.out" 2>/dev/null
	echo "--- logs"; cat "$work/run/logs.json" "$work/run/ship.json" 2>/dev/null; tail -n 5 "$work/ship.out" 2>/dev/null
	echo "--- bridge rules"; nft list table bridge qorpera_agent_exit_bridge 2>/dev/null | head -60
	echo "--- fdb"; bridge fdb show br qagent0 2>/dev/null | grep -v permanent | head
}

[[ $(id -u) -eq 0 ]] || fail "run as root"
[[ -e /etc/qorpera-throwaway-vm ]] || fail "this proof runs only inside the throwaway VM of test/prove-lxd-vm.sh"
for part in /run/netns/qexit /sys/class/net/qagent0; do [[ ! -e $part ]] || fail "$part exists"; done

work=$(mktemp -d)
chmod 0755 "$work"
export QORPERA_AGENT_EXIT_RUN_DIR=$work/run QORPERA_AGENT_EXIT_STATE_DIR=$work/state QORPERA_AGENT_EXIT_LOG_DIR=$work/log
# The logs' disk floor is off, so the proof never depends on this VM's free space; the NAS is a folder with its
# marker, as the mounted share has it.
export QORPERA_AGENT_EXIT_LOG_FLOOR_PERCENT=0 QORPERA_AGENT_EXIT_NAS_DIR=$work/nas
mkdir "$work/nas"
touch "$work/nas/.qorpera-agent-exit-logs"
pids=()
plug_pid=
cleanup() {
	set +e
	for pid in "${pids[@]}" $plug_pid; do kill "$pid" 2>/dev/null; done
	for m in $(lxc --project "$PROJECT" list -c n -f csv 2>/dev/null </dev/null); do lx delete --force "$m" >/dev/null 2>&1; done
}
trap cleanup EXIT

# --- This VM as a node ---------------------------------------------------------------------------------------------
modprobe br_netfilter
sysctl -qw net.bridge.bridge-nf-call-iptables=1
groupadd --system qorpera-agent-plug
ip netns add inet
ip -n inet link set lo up
ip link add vinet0 type veth peer name eth0 netns inet
ip addr add 198.51.100.254/24 dev vinet0
ip link set vinet0 up
ip -n inet addr add 198.51.100.1/24 dev eth0
ip -n inet link set eth0 up
ip -n inet route add default via 198.51.100.254
ip netns exec inet nft -f - <<'EOF'
table inet stand_in {
	chain input {
		type filter hook input priority 0; policy accept;
		tcp dport 81 drop
	}
}
EOF
cat >"$work/serve.py" <<'EOF'
import socket, threading
# 80: answers and closes; 8443: keeps every connection open.
def serve(port, keep):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("198.51.100.1", port))
    s.listen(4096)
    held = []
    while True:
        c = s.accept()[0]
        if keep:
            held.append(c)
        else:
            c.sendall(b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok")
            c.close()
threading.Thread(target=serve, args=(8443, True), daemon=True).start()
print("ready", flush=True)
serve(80, False)
EOF
ip netns exec inet python3 "$work/serve.py" >"$work/serve.out" 2>&1 &
pids+=($!)
wait_for "grep -q ready $work/serve.out"

bash "$tool" check >/dev/null
bash "$tool" up >/dev/null
bash "$tool" dns >"$work/dns.out" 2>&1 &
pids+=($!)
bash "$tool" log >"$work/log.out" 2>&1 &
pids+=($!)
start_plug() {
	QORPERA_AGENT_PLUG_RELOAD_DNS="pkill -HUP -x dnsmasq" QORPERA_AGENT_PLUG_INTERVAL=1 bash "$tool" plug >>"$work/plug.out" 2>&1 &
	plug_pid=$!
}
start_plug
# The logs' tender and shipper, as their timers run them on a node (more often here).
(while :; do
	bash "$tool" logs >>"$work/logs.out" 2>&1 || true
	bash "$tool" ship >>"$work/ship.out" 2>&1 || true
	sleep 20
done) &
pids+=($!)
wait_for "bash $tool verify >/dev/null 2>&1"
pass "the exit is up and healthy in the VM, with br_netfilter on as on the nodes"

# --- Real machines on the plug -----------------------------------------------------------------------------------
lxc storage create "$POOL" dir </dev/null >/dev/null
lxc project create "$PROJECT" -c features.images=false -c features.profiles=false </dev/null >/dev/null
# The creators' way: plug right before the create, then the card plug gave; never an address of their own.
machine() {
	local name=$1 company=$2 answer address hwaddr
	answer=$(python3 "$plug_tool" plug --kind machine --company "$company" --machine "$name" --project "$PROJECT" --instance "$name")
	address=$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["address"])' "$answer")
	hwaddr=$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["hwaddr"])' "$answer")
	lx init "$IMAGE" "$name" --no-profiles --storage "$POOL" -c limits.cpu=1 -c limits.memory=512MiB \
		-c user.qorpera.company_id="$company" -c user.qorpera.machine_id="$name" >/dev/null 2>&1
	lx config device add "$name" eth0 nic nictype=bridged parent=qagent0 name=eth0 hwaddr="$hwaddr" \
		ipv6.address=none security.mac_filtering=true security.ipv6_filtering=true \
		security.port_isolation=true >/dev/null
	lx start "$name"
	echo "$address"
}
a1=$(machine m1 c1)
a2=$(machine m2 c2)
wait_for "[[ \$(lease_of m1) == $a1 ]]" 900
wait_for "[[ \$(lease_of m2) == $a2 ]]" 900
wait_for "bash $tool verify >/dev/null 2>&1"
mac1=$(lx config device get m1 eth0 hwaddr)
mac2=$(lx config device get m2 eth0 hwaddr)
port2=$(lx config get m2 volatile.eth0.host_name)
pass "two LXD machines plugged in the creators' way get their addresses by DHCP from the exit"

in_m m1 python3 -c 'import urllib.request; print(urllib.request.urlopen("http://198.51.100.1/", timeout=5).read().decode())' |
	grep -qx ok || fail "a machine cannot reach the stand-in internet"
host_legs=$(conntrack -L -s "$a1" 2>/dev/null | grep -c . || true)
((host_legs == 0)) || fail "the node tracks the bridged leg despite notrack: $(conntrack -L -s "$a1" 2>&1)"
for target in 10.201.0.1:22 192.168.1.40:2049 100.64.0.1:443; do reach m1 "${target%:*}" "${target#*:}" && fail "$target reachable"; done
pass "a machine reaches the internet through the exit, not our networks; the node does not track the bridged leg"

in_m m2 sh -c 'nohup python3 -m http.server 8080 >/dev/null 2>&1 &'
sleep 1
reach m1 "$a2" 8080 && fail "a machine reached another on the bridge"
in_m m1 ip neigh flush dev eth0
in_m m1 ping -c 1 -W 2 "$a2" >/dev/null 2>&1 && fail "a machine pinged another"
in_m m1 ping -c 1 -W 2 10.210.0.1 >/dev/null || fail "a machine cannot ping the exit"
pass "port isolation: machines never reach each other, each reaches the exit"

# --- Spoofing from a plugged port, on real LXD ---------------------------------------------------------------------
exit_mac=$(ip -n qexit -br link show br0 | awk '{print $3}')
host_if=$(lx config get m1 volatile.eth0.host_name)
in_m m1 ip neigh replace 10.210.0.1 lladdr "$exit_mac" dev eth0 nud permanent
new_count() { ip netns exec qexit nft list set inet qorpera_agent_exit new_by_client | grep -o "$1 counter packets [0-9]*" || true; }
# What m1 sends from its port, counted in bridge prerouting before every filter (LXD's and ours): a refused check also
# shows its probe left the machine. Outputs are captured, never piped into grep -q (with pipefail an early exit fails).
probe_start() {
	nft add table bridge qae2b_probe
	nft add chain bridge qae2b_probe seen '{ type filter hook prerouting priority -400; }'
	nft add rule bridge qae2b_probe seen iifname "$host_if" "$@" counter
}
probe_sent() {
	local out
	out=$(nft list chain bridge qae2b_probe seen)
	nft delete table bridge qae2b_probe
	[[ $out =~ packets\ [1-9] ]]
}
cat >"$work/spoof.py" <<'EOF'
import socket, struct, sys
# argv: kind ... from inside a machine (eth0). garp IP [SHA]: an ARP reply claiming IP; frame MAC: a frame with that
# source MAC; decline OWN_IP CHADDR ADDRESS EXIT_MAC: a DHCPDECLINE naming CHADDR; syn: see below.
own = bytes.fromhex(open("/sys/class/net/eth0/address").read().strip().replace(":", ""))
raw = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
raw.bind(("eth0", 0))
kind = sys.argv[1]
if kind == "garp":
    ip = socket.inet_aton(sys.argv[2])
    sha = bytes.fromhex(sys.argv[3].replace(":", "")) if len(sys.argv) > 3 else own
    for op in (1, 2):
        raw.send(b"\xff" * 6 + own + b"\x08\x06" + struct.pack("!HHBBH", 1, 0x0800, 6, 4, op) + sha + ip + b"\xff" * 6 + ip)
elif kind == "syn":
    # Three TCP SYNs as whole frames: source MAC argv[2], to MAC argv[3], from argv[4] to argv[5] port argv[6], from
    # source ports argv[7] onwards (each check its own, so no check meets another's connections). A raw
    # frame leaves the card whatever its routes and neighbours are.
    src, dst = socket.inet_aton(sys.argv[4]), socket.inet_aton(sys.argv[5])
    def csum(b):
        b += b"\0" * (len(b) % 2)
        t = sum(struct.unpack("!%dH" % (len(b) // 2), b))
        while t >> 16:
            t = (t & 0xffff) + (t >> 16)
        return ~t & 0xffff
    for n in range(3):
        tcp = struct.pack("!HHIIBBHHH", int(sys.argv[7]) + n, int(sys.argv[6]), 7, 0, 5 << 4, 0x02, 64240, 0, 0)
        tcp = tcp[:16] + struct.pack("!H", csum(src + dst + struct.pack("!BBH", 0, 6, len(tcp)) + tcp)) + tcp[18:]
        ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(tcp), 100 + n, 0, 64, 6, 0, src, dst)
        ip = ip[:10] + struct.pack("!H", csum(ip)) + ip[12:]
        raw.send(bytes.fromhex(sys.argv[3].replace(":", "")) + bytes.fromhex(sys.argv[2].replace(":", "")) + b"\x08\x00" + ip + tcp)
elif kind == "frame":
    raw.send(b"\xff" * 6 + bytes.fromhex(sys.argv[2].replace(":", "")) + b"\x08\x00" + b"\x45" + b"\x00" * 45)
elif kind == "decline":
    # A whole frame, from the machine's own MAC and address and from port 68 (dnsmasq answers only that), to the
    # exit's MAC (argv[5]): only the chaddr names another machine.
    zero = b"\0" * 4
    bootp = struct.pack("!BBBBIHH4s4s4s4s", 1, 1, 6, 0, 0x5150, 0, 0, zero, zero, zero, zero)
    bootp += bytes.fromhex(sys.argv[3].replace(":", "")) + b"\0" * 202 + b"\x63\x82\x53\x63"
    bootp += bytes([53, 1, 4, 50, 4]) + socket.inet_aton(sys.argv[4]) + bytes([54, 4]) + socket.inet_aton("10.210.0.1") + bytes([255])
    udp = struct.pack("!HHHH", 68, 67, 8 + len(bootp), 0) + bootp
    ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(udp), 1, 0, 64, 17, 0, socket.inet_aton(sys.argv[2]), socket.inet_aton("10.210.0.1"))
    total = sum(struct.unpack("!10H", ip))
    while total >> 16:
        total = (total & 0xffff) + (total >> 16)
    ip = ip[:10] + struct.pack("!H", ~total & 0xffff) + ip[12:]
    raw.send(bytes.fromhex(sys.argv[5].replace(":", "")) + own + b"\x08\x00" + ip + udp)
EOF
lx file push "$work/spoof.py" m1/root/spoof.py >/dev/null
# Three SYNs from m1's card with the source MAC $1 and m1's own address, to the site, from source ports $2 onwards:
# did the exit forward them?
syn_from() {
	in_m m1 python3 /root/spoof.py syn "$1" "$exit_mac" "$a1" 198.51.100.1 80 "$2"
	sleep 0.5
}
new_packets() { new_count "$1" | awk '{print $NF}'; }
# LXD's own layers on each machine's port, each tested with ours opened for it (the reconciler stopped meanwhile, so
# it cannot close them again): port isolation, its MAC filter and its IPv6 filter must hold by themselves.
for port in "$(lx config get m1 volatile.eth0.host_name)" "$(lx config get m2 volatile.eth0.host_name)"; do
	[[ $(cat "/sys/class/net/$port/brport/isolated") == 1 ]] || fail "LXD did not isolate $port"
done
kill "$plug_pid"
wait "$plug_pid" 2>/dev/null || true
nft add element bridge qorpera_agent_exit_bridge ports "{ \"$host_if\" . 0e:51:0a:d2:99:98 }"
nft add element bridge qorpera_agent_exit_bridge clients "{ 0e:51:0a:d2:99:98 . $a1 }"
# The method first: SYNs from m1's own MAC are forwarded and counted by the exit.
before=$(new_packets "$a1")
syn_from "$mac1" 41000
(($(new_packets "$a1") == before + 3)) || fail "the positive control: the exit counted $(($(new_packets "$a1") - before)) of m1's 3 SYNs"
# Our rules know the other MAC and address, so only LXD's MAC filter can stop it: the exit must forward nothing.
before=$(new_count "$a1")
probe_start ether saddr 0e:51:0a:d2:99:98 tcp dport 80
syn_from 0e:51:0a:d2:99:98 42000
probe_sent || fail "the SYNs with another MAC never left m1"
[[ $(new_count "$a1") == "$before" ]] || fail "LXD's MAC filter let another MAC through to the exit"
# Our rules let m1's IPv6 through, so only LXD's IPv6 filter can stop it before forward priority 100.
nft insert rule bridge qorpera_agent_exit_bridge forward iifname "$host_if" ether type ip6 accept
nft add table bridge qae2b_lxd6
nft add chain bridge qae2b_lxd6 seen '{ type filter hook forward priority 100; }'
nft add rule bridge qae2b_lxd6 seen iifname "$host_if" ether type ip6 counter
probe_start ether type ip6
in_m m1 sh -c 'sysctl -qw net.ipv6.conf.eth0.disable_ipv6=0; ping -6 -c 3 -W 1 ff02::1%eth0' >/dev/null 2>&1 || true
probe_sent || fail "m1 sent no IPv6 to test LXD's IPv6 filter with"
lxd6=$(nft list chain bridge qae2b_lxd6 seen)
[[ $lxd6 == *"packets 0 "* ]] || fail "LXD's IPv6 filter let IPv6 through: $lxd6"
nft delete table bridge qae2b_lxd6
handle=$(nft -a list chain bridge qorpera_agent_exit_bridge forward | awk '/ether type ip6 accept/ {print $NF}')
nft delete rule bridge qorpera_agent_exit_bridge forward handle "$handle"
start_plug
wait_for "! nft list set bridge qorpera_agent_exit_bridge clients | grep -q 0e:51:0a:d2:99:98" 100
wait_for "reach m1 198.51.100.1 80" 100
pass "LXD isolates each machine's port, and its MAC and IPv6 filters hold on their own"
# Another address than its own (in the range, and another machine's), towards the internet: the exit counts every
# connection it forwards, so a spoofed one would show there.
from_addr() { in_m m1 timeout 4 python3 -c 'import socket, sys; s = socket.socket(); s.settimeout(3); s.bind((sys.argv[1], 0)); s.connect(("198.51.100.1", 80))' "$1" 2>/dev/null; }
reach m1 198.51.100.1 80 || fail "the positive control: m1 cannot reach the site from its own address"
in_m m1 ip addr add 10.210.9.9/16 dev eth0
from_addr 10.210.9.9 && fail "another IPv4 source got through"
in_m m1 ip addr del 10.210.9.9/16 dev eth0
a2_before=$(new_count "$a2")
in_m m1 ip addr add "$a2/32" dev eth0
from_addr "$a2" && fail "another machine's address got through"
in_m m1 ip addr del "$a2/32" dev eth0
[[ -z $(new_count 10.210.9.9) ]] || fail "the exit forwarded a spoofed address"
[[ $(new_count "$a2") == "$a2_before" ]] || fail "the exit forwarded a connection from another machine's address"
# Another MAC than its own.
before=$(new_count "$a1")
probe_start ether saddr 0e:51:0a:d2:99:99 tcp dport 80
syn_from 0e:51:0a:d2:99:99 43000
probe_sent || fail "the SYNs with another MAC never left m1"
[[ $(new_count "$a1") == "$before" ]] || fail "the exit saw a machine's address from another MAC"
# IPv6: none of it reaches the bridge.
nft add table bridge qae2b_count
# After LXD's filters and ours (forward, priority 100): nothing of a machine's IPv6 is left.
nft add chain bridge qae2b_count seen '{ type filter hook forward priority 100; }'
nft add rule bridge qae2b_count seen iifname "$host_if" ether type ip6 counter
probe_start ether type ip6
in_m m1 sh -c 'sysctl -qw net.ipv6.conf.eth0.disable_ipv6=0; ping -6 -c 3 -W 1 ff02::1%eth0' >/dev/null 2>&1 || true
probe_sent || fail "m1 sent no IPv6 to test with"
count6=$(nft list chain bridge qae2b_count seen)
[[ $count6 == *"packets 0 "* ]] || fail "a machine's IPv6 got through: $count6"
nft delete table bridge qae2b_count
pass "another address, another machine's address, another MAC or any IPv6 from a machine's card gets nothing through"
in_m m2 ping -c 1 -W 2 10.210.0.1 >/dev/null || fail "m2 cannot ping the exit"
wait_for "ip -n qexit neigh show $a2 | grep -q $mac2"
in_m m1 python3 /root/spoof.py garp "$a2"
in_m m1 python3 /root/spoof.py garp "$a1" "$mac2"
# The DHCPDECLINE reaches the bridge (counted before its rules: they hook forward at filter - 5, and the bridge
# family's filter is -200) and goes no further: dnsmasq would log it.
nft add table bridge qae2b_dhcp
nft add chain bridge qae2b_dhcp seen '{ type filter hook forward priority -300; }'
nft add rule bridge qae2b_dhcp seen iifname "$host_if" udp dport 67 @th,96,32 0x5150 counter
in_m m1 python3 /root/spoof.py decline "$a1" "$mac2" "$a2" "$exit_mac"
sleep 0.5
decline=$(nft list chain bridge qae2b_dhcp seen)
[[ $decline =~ packets\ [1-9] ]] || fail "the DHCPDECLINE never reached the bridge"
nft delete table bridge qae2b_dhcp
for stolen in "$mac2" "$exit_mac"; do in_m m1 python3 /root/spoof.py frame "$stolen"; done
sleep 1
neigh2=$(ip -n qexit neigh show "$a2")
[[ $neigh2 == *"$mac2"* ]] || fail "gratuitous ARP moved another machine's address: $(ip -n qexit neigh)"
neigh1=$(ip -n qexit neigh show "$a1")
[[ $neigh1 == *"$mac2"* ]] && fail "an ARP sender MAC moved a machine's address"
grep -q DHCPDECLINE "$work/log/dns.log" && fail "a machine declined another's lease"
fdb=$(bridge fdb show br qagent0)
[[ $fdb == *"$mac2 dev $port2"* ]] || fail "another machine's MAC moved: $fdb"
[[ $fdb == *"$exit_mac dev $host_if"* ]] && fail "the exit's MAC moved to a machine"
pass "no gratuitous ARP for another's address, no ARP sender MAC, no DHCP naming another's MAC, no MAC theft"
# A frame from the exit to a MAC the bridge has forgotten reaches only that machine's port.
nft add table bridge qae2b_flood
nft add chain bridge qae2b_flood seen '{ type filter hook forward priority 100; }'
nft add rule bridge qae2b_flood seen oifname "$port2" ether daddr "$mac1" counter
bridge fdb del "$mac1" dev "$host_if" master 2>/dev/null || true
bridge fdb show br qagent0 | grep -q "$mac1 dev $host_if" && fail "m1's MAC is still in the bridge table"
ip netns exec qexit ping -c 1 -W 1 "$a1" >/dev/null 2>&1 || true
nft list chain bridge qae2b_flood seen | grep -q 'packets 0 ' || fail "the exit's frame to a forgotten MAC reached another machine"
nft delete table bridge qae2b_flood
pass "a frame from the exit to a MAC the bridge has forgotten reaches no other machine"

# --- Default deny, and the rules set right ---------------------------------------------------------------------------
kill "$plug_pid"
wait "$plug_pid" 2>/dev/null || true
a3=$(machine m3 c3)
sleep 20
[[ -z $(lease_of m3) ]] || fail "a machine got an address before the reconciler had it in the bridge rules"
start_plug
wait_for "[[ \$(lease_of m3) == $a3 ]]" 600
pass "a new machine gets nothing until the reconciler has it in the bridge rules, then its address"
# The reconciler down and the pairs lost (as after a crash and a hand flush): nothing passes; restarted, it sets the
# rules right within a pass.
kill "$plug_pid"
wait "$plug_pid" 2>/dev/null || true
nft flush set bridge qorpera_agent_exit_bridge clients
reach m1 198.51.100.1 80 && fail "traffic passed with the pairs flushed"
start_plug
wait_for "reach m1 198.51.100.1 80" 100
pass "with the pairs lost nothing passes; the reconciler, restarted, sets the rules right within a pass"
# With the reconciler down, so only `up` itself can keep them.
kill "$plug_pid"
wait "$plug_pid" 2>/dev/null || true
bash "$tool" up >/dev/null
reach m1 198.51.100.1 80 || fail "an up reload cut a running machine off"
start_plug
pass "an up reload keeps the ports and pairs by itself: running machines keep their traffic"

# --- The reconciler against LXD ------------------------------------------------------------------------------------
in_m m1 sh -c 'nohup python3 -c "import socket, time; s = socket.create_connection((\"198.51.100.1\", 8443)); time.sleep(3600)" >/dev/null 2>&1 &'
wait_for "ip netns exec qexit conntrack -L -s $a1 2>/dev/null | grep -q 'dport=8443'"
wait_for "conntrack -L -s 10.209.255.2 2>/dev/null | grep -q 'dport=8443'"
lx stop --force m1
wait_for "test -e $work/run/plug-stopped/$a1" 100
exit_left=$(ip netns exec qexit conntrack -L -s "$a1" 2>/dev/null || true)
[[ $exit_left == *dport=8443* ]] && fail "the exit kept a sleeping machine's connection"
node_left=$(conntrack -L -s 10.209.255.2 2>/dev/null || true)
[[ $node_left == *dport=8443* ]] && fail "the node kept its twin"
lx start m1
wait_for "[[ \$(lease_of m1) == $a1 ]]" 600
pass "a machine that sleeps loses its connections in both tables and wakes with its address"
lx delete --force m3
wait_for "test ! -e $work/state/clients/$a3.json" 100
[[ -e $work/state/quarantine/$a3 ]] || fail "no quarantine for a deleted machine"
lx init "$IMAGE" stray --no-profiles --storage "$POOL" >/dev/null 2>&1
lx config device add stray eth0 nic nictype=bridged parent=qagent0 name=eth0 >/dev/null
wait_for "grep -q 'stray is on qagent0 without a client map entry' $work/run/plug.json" 100
lx delete --force stray
wait_for "bash $tool verify >/dev/null 2>&1"
pass "a deleted machine is unplugged into quarantine; a stray card makes the exit unhealthy until it is gone"

# --- Floods and the tables ------------------------------------------------------------------------------------------
cat >"$work/flood.py" <<'EOF'
import socket, struct, sys, time
# argv: kind count [cap seconds, default 60]. Prints the seconds it took and how many it sent.
kind, count = sys.argv[1], int(sys.argv[2])
cap = float(sys.argv[3]) if len(sys.argv) > 3 else 60.0
start, sent = time.time(), 0
def more():
    global sent
    if time.time() - start >= cap:
        return False
    sent += 1
    return True
if kind == "churn":
    for _ in range(count):
        if not more():
            break
        try:
            s = socket.create_connection(("198.51.100.1", 80), 2)
            s.recv(64)
            s.close()
        except OSError:
            pass
elif kind in ("silent", "refused"):
    socks = []
    for i in range(count):
        if not more():
            break
        s = socket.socket()
        s.setblocking(False)
        s.connect_ex(("198.51.100.1", 81) if kind == "silent" else ("192.168.1.40", 10000 + i % 50000))
        socks.append(s)
        if len(socks) > 900:
            socks.pop(0).close()
elif kind == "udp":
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    for i in range(count):
        if not more():
            break
        s.sendto(b"x", ("198.51.100.1", 10000 + i % 50000))
elif kind == "other":
    s = socket.socket(socket.AF_INET, socket.SOCK_RAW, 253)
    for i in range(count):
        if not more():
            break
        s.sendto(b"x" * 8, ("198.51.100.%d" % (2 + i % 250), 0))
elif kind == "spoofed":
    r = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW)
    for i in range(count):
        if not more():
            break
        src = socket.inet_aton("10.210.%d.%d" % (100 + i % 100, 1 + i % 250))
        ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 29, i & 0xffff, 0, 64, 17, 0, src, socket.inet_aton("198.51.100.1"))
        r.sendto(ip + struct.pack("!HHHH", 40000, 9, 9, 0) + b"x", ("198.51.100.1", 0))
elif kind == "ipv6":
    s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
    for i in range(count):
        if not more():
            break
        try:
            s.sendto(b"x", ("ff02::1%eth0", 10000 + i % 50000))
        except OSError:
            pass
print("%.2f %d" % (time.time() - start, sent))
EOF
lx file push "$work/flood.py" m1/root/flood.py >/dev/null
lx file push "$work/flood.py" m2/root/flood.py >/dev/null
counter() { ip netns exec qexit nft list counter inet qorpera_agent_exit "$1" | awk '/packets/ {print $2}'; }
results=()
flood() {
	local label=$1 kind=$2 seconds sent exit_before node_before exit_after node_after limit_before limit_after
	ip netns exec qexit conntrack -F >/dev/null 2>&1 || true
	conntrack -F >/dev/null 2>&1 || true
	sleep 1
	exit_before=$(ip netns exec qexit conntrack -C)
	node_before=$(conntrack -C)
	limit_before=$(counter refused_open_limit)
	read -r seconds sent < <(in_m m1 python3 /root/flood.py "$kind" "$FLOOD")
	sleep 1
	exit_after=$(ip netns exec qexit conntrack -C)
	node_after=$(conntrack -C)
	limit_after=$(counter refused_open_limit)
	results+=("{\"flood\":\"$label\",\"sent\":$sent,\"seconds\":$seconds,\"exit_table\":$((exit_after - exit_before)),\"node_table\":$((node_after - node_before)),\"over_the_bound\":$((limit_after - limit_before))}")
	printf 'flood %-20s %6d sent in %6ss: exit table %+7d, node table %+7d, over the bound %d\n' "$label" "$sent" \
		"$seconds" "$((exit_after - exit_before))" "$((node_after - node_before))" "$((limit_after - limit_before))"
}
for kind in churn silent refused udp other spoofed ipv6; do flood "$kind" "$kind"; done
# Closed agent connections leave both tables within 30 seconds (the kernel's default is 120): TIME_WAIT entries right
# after a churn, and 35 seconds later.
time_waits() { "$@" conntrack -L -p tcp --state TIME_WAIT 2>/dev/null | grep -c . || true; }
ip netns exec qexit conntrack -F >/dev/null 2>&1 || true
conntrack -F >/dev/null 2>&1 || true
in_m m1 python3 /root/flood.py churn 5000 >/dev/null
exit_tw=$(time_waits ip netns exec qexit)
node_tw=$(time_waits)
sleep 35
exit_tw_later=$(time_waits ip netns exec qexit)
node_tw_later=$(time_waits)
results+=("{\"time_wait\":\"after 5000 connections\",\"exit\":$exit_tw,\"node\":$node_tw,\"exit_35s_later\":$exit_tw_later,\"node_35s_later\":$node_tw_later}")
echo "TIME_WAIT after 5000 connections: exit $exit_tw, node $node_tw; 35 s later: exit $exit_tw_later, node $node_tw_later"
((exit_tw > 1000 && node_tw > 1000)) || fail "the churn left no TIME_WAIT entries to measure"
((exit_tw_later < 50 && node_tw_later < 50)) || fail "closed agent connections stayed past 30 seconds"
pass "closed agent connections leave both tables within 30 seconds"
# The same without notrack, for comparison: the node's own table then holds the bridged leg too.
handle=$(nft -a list chain inet qorpera_agent_exit_host raw_prerouting | awk '/notrack/ {print $NF}')
nft delete rule inet qorpera_agent_exit_host raw_prerouting handle "$handle"
for kind in churn refused udp spoofed; do flood "$kind, tracked" "$kind"; done
bash "$tool" up >/dev/null
nft list chain inet qorpera_agent_exit_host raw_prerouting | grep -q notrack || fail "up did not restore notrack"
ip netns exec qexit conntrack -F >/dev/null 2>&1 || true
read -r idle _ < <(in_m m1 python3 /root/flood.py churn 5000)
in_m m2 sh -c 'nohup python3 /root/flood.py silent 16000 >/dev/null 2>&1 &'
wait_for "test \$(ip netns exec qexit conntrack -C) -gt 14000" 300
read -r busy _ < <(in_m m1 python3 /root/flood.py churn 5000)
results+=("{\"cost\":\"5000 connections\",\"seconds_with_an_empty_table\":$idle,\"seconds_with_over_14000_and_a_flood\":$busy}")
echo "cost: 5000 connections in ${idle}s with an empty table, ${busy}s with over 14,000 entries and m2 still flooding"
wait_for "bash $tool verify >/dev/null 2>&1" 300
pass "the floods ran within their caps; the exit stayed healthy"
echo "RESULT {\"kernel\":\"$(uname -r)\",\"lxd\":\"$(snap list lxd | awk 'NR==2 {print $2":"$3}')\",\"floods\":[$(IFS=,; echo "${results[*]}")]}"
echo "ALL PASSED"
