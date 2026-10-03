#!/usr/bin/env bash
# Root proof for the agent exit. It runs as root inside a privileged, network-less throwaway container that plays a
# node: the container's own namespace is the node, and namespaces inside it are an agent machine, the office network
# (router, NAS, node 1), a small internet (a site, a resolver, our public address) and node 1 on the tailnet. It
# builds the exit with the real tool and rules, plugs the agent machine in, and checks what reaches what.
# qorpera-agent-exit.test.mjs builds the container and runs this file. Prints PASS lines; any failure exits 1.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tool="$here/qorpera-agent-exit.sh"
work=$(mktemp -d)
# dnsmasq drops to an unprivileged user and must still read the leases directory.
chmod 0755 "$work"
export QORPERA_AGENT_EXIT_RUN_DIR=$work/run QORPERA_AGENT_EXIT_STATE_DIR=$work/state
export QORPERA_AGENT_EXIT_LOG_DIR=$work/log QORPERA_AGENT_EXIT_UPSTREAMS=9.9.9.9
pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

fail() {
	echo "FAIL: $*" >&2
	exit 1
}
pass() { echo "PASS: $*"; }
connects() { ip netns exec "$1" timeout 3 bash -c "exec 3<>/dev/tcp/$2/$3" 2>/dev/null; }
# Refused at once (a reset or ICMP), not by a timeout.
refused_now() {
	local start elapsed
	start=$(date +%s%N)
	if connects "$1" "$2" "$3"; then return 1; fi
	elapsed=$((($(date +%s%N) - start) / 1000000))
	((elapsed < 2000))
}
wait_for() {
	local i
	for i in $(seq 1 50); do
		if eval "$1"; then return 0; fi
		sleep 0.2
	done
	fail "timed out waiting for: $1"
}

cat >"$work/serve.py" <<'EOF'
import socket, sys, threading
# TCP listeners that write each peer to a file; argv: file host:port...
out = open(sys.argv[1], "a", buffering=1)
socks = []
for a in sys.argv[2:]:
    host, port = a.rsplit(":", 1)
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((host, int(port)))
    s.listen(16)
    socks.append(s)
def serve(s):
    while True:
        c, peer = s.accept()
        out.write("%s:%d %s\n" % (s.getsockname()[0], s.getsockname()[1], peer[0]))
        c.sendall(b"hello")
        c.close()
for s in socks:
    threading.Thread(target=serve, args=(s,), daemon=True).start()
print("ready", flush=True)
threading.Event().wait()
EOF
cat >"$work/resolver.py" <<'EOF'
import socket
# A public resolver stand-in: every A question is answered with 1.1.1.1.
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("9.9.9.9", 53))
print("ready", flush=True)
while True:
    q, peer = s.recvfrom(512)
    i = 12
    while q[i] != 0:
        i += q[i] + 1
    question = q[12:i + 5]
    answer = b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x3c\x00\x04" + bytes([1, 1, 1, 1])
    s.sendto(q[:2] + b"\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00" + question + answer, peer)
EOF
cat >"$work/ask.py" <<'EOF'
import socket, struct, sys
# One A question for argv[2] to the server argv[1]; prints the first answer's address, or "none".
name = sys.argv[2]
q = struct.pack("!HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0)
q += b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\x00" + struct.pack("!HH", 1, 1)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(2)
try:
    s.sendto(q, (sys.argv[1], 53))
    r, _ = s.recvfrom(512)
    print(".".join(str(b) for b in r[-4:]) if struct.unpack("!H", r[6:8])[0] else "none")
except Exception:
    print("none")
EOF
cat >"$work/from.py" <<'EOF'
import socket, sys
s = socket.socket()
s.settimeout(0.5)
s.bind((sys.argv[1], 0))
try:
    s.connect((sys.argv[2], int(sys.argv[3])))
    print("open")
except Exception:
    print("closed")
EOF
cat >"$work/raw.py" <<'EOF'
import socket, sys
# One raw IP packet of protocol argv[3] to argv[2] (the kernel fills in the source, argv[1] is for the reader).
s = socket.socket(socket.AF_INET, socket.SOCK_RAW, int(sys.argv[3]))
s.sendto(b"x" * 8, (sys.argv[2], 0))
EOF
cat >"$work/spoofdns.py" <<'EOF'
import socket, struct, sys
# A DNS question for argv[3] to argv[2], sent from the forged source argv[1] (raw IP + UDP).
def csum(b):
    if len(b) % 2:
        b += b"\0"
    s = sum(struct.unpack("!%dH" % (len(b) // 2), b))
    while s >> 16:
        s = (s & 0xffff) + (s >> 16)
    return ~s & 0xffff
src, dst, name = sys.argv[1], sys.argv[2], sys.argv[3]
q = struct.pack("!HHHHHH", 0x4242, 0x0100, 1, 0, 0, 0)
q += b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\x00" + struct.pack("!HH", 1, 1)
udp = struct.pack("!HHHH", 40000, 53, 8 + len(q), 0) + q
ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(udp), 1, 0, 64, 17, 0, socket.inet_aton(src), socket.inet_aton(dst))
ip = ip[:10] + struct.pack("!H", csum(ip)) + ip[12:]
r = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW)
r.sendto(ip + udp, (dst, 0))
print("sent")
EOF
cat >"$work/udp.py" <<'EOF'
import socket, sys
socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b"probe", (sys.argv[1], int(sys.argv[2])))
EOF
cat >"$work/udpseen.py" <<'EOF'
import socket, sys
# Writes the source of every datagram to argv[1]; listens on argv[2]:argv[3].
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind((sys.argv[2], int(sys.argv[3])))
print("ready", flush=True)
while True:
    data, peer = s.recvfrom(512)
    with open(sys.argv[1], "a") as f:
        f.write("%s %s\n" % (peer[0], data.decode()))
EOF
cat >"$work/udhcpc.sh" <<'EOF'
#!/bin/sh
[ "$1" = bound ] && echo "ip=$ip router=$router dns=$dns" > "$LEASE_FILE"
exit 0
EOF
chmod +x "$work/udhcpc.sh"

# Starts a helper in a namespace (or on the node with "-") and waits for its "ready" line.
background() {
	local ns=$1 out=$2
	shift 2
	if [[ $ns == - ]]; then "$@" >"$out" 2>&1 & else ip netns exec "$ns" "$@" >"$out" 2>&1 & fi
	pids+=($!)
	wait_for "grep -q ready $out"
}

# --- The node and its surroundings -------------------------------------------------------------------------------
sysctl -qw net.ipv4.ip_forward=1
ip link set lo up
ip netns add lan
ip -n lan link set lo up
ip link add lan0 type veth peer name lan1 netns lan
ip addr add 192.168.1.42/24 dev lan0
ip link set lan0 up
ip route replace default via 192.168.1.1
for address in 192.168.1.1/24 192.168.1.40/24 192.168.1.27/24; do ip -n lan addr add "$address" dev lan1; done
ip -n lan link set lan1 up
for address in 1.1.1.1/32 9.9.9.9/32 93.164.62.162/32; do ip -n lan addr add "$address" dev lo; done
# The office network has no route to the exit's addresses: what arrives must come from the node's own address.
ip netns add tail
ip -n tail link set lo up
ip link add tailscale0 type veth peer name ts1 netns tail
ip addr add 100.80.160.64/32 dev tailscale0
ip link set tailscale0 up
ip route add 100.64.0.0/10 dev tailscale0
ip -n tail addr add 100.75.4.70/32 dev ts1
ip -n tail link set ts1 up
ip -n tail route add 100.80.160.64/32 dev ts1
ip -n tail route add 10.0.0.0/8 via 100.80.160.64 dev ts1 onlink

ip netns add agent
ip -n agent link set lo up

background lan "$work/lan.out" python3 "$work/serve.py" "$work/lan-peers" 1.1.1.1:443 1.1.1.1:25 192.168.1.40:2049 \
	192.168.1.1:80 192.168.1.27:22 93.164.62.162:443
background lan "$work/resolver.out" python3 "$work/resolver.py"
background lan "$work/udpseen.out" python3 "$work/udpseen.py" "$work/nas-udp" 192.168.1.40 9999
background tail "$work/tail.out" python3 "$work/serve.py" "$work/tail-peers" 100.75.4.70:22

# --- The exit ---------------------------------------------------------------------------------------------------
bash "$tool" check >"$work/check.out" || fail "check: $(cat "$work/check.out")"
pass "check: rules parse and the tools are present"
bash "$tool" up >/dev/null
bash "$tool" up >/dev/null || fail "a second up must repair, not fail"
pass "up twice"
if bash "$tool" verify 2>"$work/verify.err"; then fail "verify passed without DNS and the logger"; fi
grep -q "no DNS on 10.210.0.1:53" "$work/verify.err" || fail "verify: $(cat "$work/verify.err")"
grep -q "logger not running" "$work/verify.err" || fail "verify: $(cat "$work/verify.err")"
pass "verify fails while DNS and the logger are not running"

background - "$work/node.out" python3 "$work/serve.py" "$work/node-peers" 192.168.1.42:22 10.209.255.1:22
background qexit "$work/exit.out" python3 "$work/serve.py" "$work/exit-peers" 10.210.0.1:2222

# The agent machine, plugged in as the agent plug (E2) will: a port of qagent0 and a static lease.
mkdir -p "$QORPERA_AGENT_EXIT_STATE_DIR/dhcp-hosts"
echo "52:54:00:00:10:10,10.210.0.10" >"$QORPERA_AGENT_EXIT_STATE_DIR/dhcp-hosts/agent-test"
ip link add va0 type veth peer name eth0 netns agent
ip -n agent link set eth0 address 52:54:00:00:10:10
ip link set va0 master qagent0 up
ip -n agent link set eth0 up

bash "$tool" dns >"$work/dns.out" 2>&1 &
pids+=($!)
wait_for "ip netns exec qexit ss -lnu | grep -q '10.210.0.1:53 '"
bash "$tool" log >"$work/log.out" 2>&1 &
pids+=($!)
wait_for "test -e $QORPERA_AGENT_EXIT_RUN_DIR/logger.heartbeat"
bash "$tool" verify >/dev/null || fail "verify with everything running"
pass "verify passes with DNS and the logger running"

# --- DHCP and names -----------------------------------------------------------------------------------------------
LEASE_FILE=$work/lease ip netns exec agent env LEASE_FILE="$work/lease" busybox udhcpc -i eth0 -n -q -f -t 5 -T 1 \
	-s "$work/udhcpc.sh" >/dev/null 2>&1 || fail "no DHCP lease: $(tail -5 "$QORPERA_AGENT_EXIT_LOG_DIR/dns.log" 2>&1)"
grep -q "ip=10.210.0.10 router=10.210.0.1 dns=10.210.0.1" "$work/lease" || fail "lease: $(cat "$work/lease")"
ip -n agent addr add 10.210.0.10/16 dev eth0
ip -n agent route add default via 10.210.0.1
pass "DHCP gives the machine its static address, the exit as router and as DNS"

[[ $(ip netns exec agent python3 "$work/ask.py" 10.210.0.1 example.test) == 1.1.1.1 ]] || fail "DNS through the exit"
[[ $(ip netns exec agent python3 "$work/ask.py" 8.8.8.8 other.test) == 1.1.1.1 ]] || fail "DNS to another resolver is not redirected"
wait_for "grep -q 'query\[A\] example.test from 10.210.0.10' $QORPERA_AGENT_EXIT_LOG_DIR/dns.log"
wait_for "grep -q 'query\[A\] other.test from 10.210.0.10' $QORPERA_AGENT_EXIT_LOG_DIR/dns.log"
pass "names resolve through the exit, plain DNS elsewhere is redirected, and every query is logged"

# --- What reaches what --------------------------------------------------------------------------------------------
connects agent 1.1.1.1 443 || fail "the agent machine cannot reach a website"
wait_for "grep -q '1.1.1.1:443 192.168.1.42' $work/lan-peers"
grep -q '1.1.1.1:443 10\.' "$work/lan-peers" && fail "a site saw an inside address"
pass "a website is reached, and sees the node's address (phase 1)"
for target in 1.1.1.1:25 192.168.1.40:2049 192.168.1.1:80 192.168.1.27:22 192.168.1.42:22 10.209.255.1:22 \
	100.75.4.70:22 93.164.62.162:443; do
	refused_now agent "${target%:*}" "${target#*:}" || fail "$target is not refused at once"
done
pass "mail servers, the NAS, the router, both nodes, the uplink, Tailscale and our public address are refused at once"
connects agent 10.210.0.1 2222 && fail "the exit itself answers more than DNS and DHCP"
pass "the exit itself is closed to agent machines"
connects qexit 192.168.1.40 2049 && fail "the exit's own uplink reaches the NAS"
connects qexit 10.209.255.1 22 && fail "the exit's own uplink reaches the node"
pass "the node's second line: the uplink reaches neither the office network nor the node"
ip -n agent addr add 172.20.0.5/32 dev eth0
[[ $(ip netns exec agent python3 "$work/from.py" 172.20.0.5 1.1.1.1 443) == closed ]] || fail "a spoofed source got out"
ip netns exec qexit nft list counter inet qorpera_agent_exit refused_spoofed | grep -Eq 'packets [1-9]' || fail "spoofed not counted"
pass "a source outside the agent range is dropped and counted"
ip netns exec agent python3 "$work/raw.py" 10.210.0.10 192.168.1.40 253
connects agent 192.168.1.40 2049 && fail "the NAS is reachable"
pass "a refusal by another protocol (253) next to a TCP one"
[[ $(ip netns exec agent python3 "$work/spoofdns.py" 172.20.0.5 10.210.0.1 spoofed.test) == sent ]] || fail "spoofed DNS not sent"
sleep 1
grep -q "spoofed.test" "$QORPERA_AGENT_EXIT_LOG_DIR/dns.log" && fail "the exit answered DNS from a source outside the agent range"
pass "the exit ignores DNS from a source outside the agent range"
# Routing through the node: send to the NAS with the bridge's own MAC as the next hop. The node must not route it.
bridge_mac=$(cat /sys/class/net/qagent0/address)
ip -n agent neigh replace 10.210.255.254 lladdr "$bridge_mac" dev eth0 nud permanent
ip -n agent route add 192.168.1.40/32 via 10.210.255.254 dev eth0
ip netns exec agent python3 "$work/udp.py" 192.168.1.40 9999
sleep 1
[[ -s $work/nas-udp ]] && fail "the node routed a packet from the agents' bridge to the NAS: $(cat "$work/nas-udp")"
ip -n agent route del 192.168.1.40/32
pass "the node routes nothing from the agents' bridge (a send with the bridge as next hop never reaches the NAS)"
# The node owns 192.168.1.42; without arp_ignore it would answer ARP for it on any interface, the bridge included.
ip -n agent route add 192.168.1.42/32 dev eth0
ip netns exec agent python3 "$work/udp.py" 192.168.1.42 9 >/dev/null 2>&1 || true
sleep 1.5
ip -n agent neigh show 192.168.1.42 | grep -q lladdr && fail "the node answered ARP on the agents' bridge: $(ip -n agent neigh show 192.168.1.42)"
ip -n agent route del 192.168.1.42/32
pass "the node does not answer ARP on the agents' bridge"
ip netns exec qexit nft list set inet qorpera_agent_exit new_by_client | grep -Eq '10\.210\.0\.10 counter packets [1-9]' ||
	fail "new connections are not counted per client: $(ip netns exec qexit nft list set inet qorpera_agent_exit new_by_client)"
pass "new connections are counted per client"

# --- The log ------------------------------------------------------------------------------------------------------
ip netns exec qexit conntrack -F >/dev/null 2>&1
wait_for "ls $QORPERA_AGENT_EXIT_LOG_DIR/flows-*.jsonl >/dev/null 2>&1 && grep -q '\"event\":\"destroy\"' $QORPERA_AGENT_EXIT_LOG_DIR/flows-*.jsonl"
log_file=$(ls "$QORPERA_AGENT_EXIT_LOG_DIR"/flows-*.jsonl | head -1)
for _ in $(seq 1 50); do
	grep -q '"event":"refused","proto":"253"' "$log_file" && break
	sleep 0.2
done
grep -q '"event":"refused","proto":"253"' "$log_file" || fail "no protocol-253 refusal in the log: $(cat "$log_file")"
python3 - "$log_file" >"$work/logcheck.out" 2>&1 <<'EOF' || fail "log: $(cat "$work/logcheck.out")"
import json, sys
records = [json.loads(line) for line in open(sys.argv[1])]
site = [r for r in records if r["event"] == "destroy" and r.get("dst") == "1.1.1.1" and r.get("dport") == 443]
assert site and site[0]["src"] == "10.210.0.10" and site[0]["bytes_out"] > 0 and site[0]["bytes_in"] > 0, site
assert all(r["src"].startswith("10.210.") and r["src"] != "10.210.0.1" for r in records if r["event"] != "gap"), "not an agent's"

EOF
for _ in $(seq 1 50); do
	grep -q '"dst":"192.168.1.40","event":"refused"' "$log_file" && break
	sleep 0.2
done
grep -q '"dst":"192.168.1.40","event":"refused"' "$log_file" || fail "no refused flow in the log.
logger: $(cat "$work/log.out")
set: $(ip netns exec qexit nft -j list set inet qorpera_agent_exit refused_flows 2>&1)
log: $(cat "$log_file")"
pass "the log has each connection's end with bytes, and the refused flows, for agent machines only"

# --- Fail closed -------------------------------------------------------------------------------------------------
if bash "$tool" down 2>"$work/down.err"; then fail "down went ahead with a machine plugged in"; fi
grep -q "agent road machines are plugged in (va0" "$work/down.err" || fail "down: $(cat "$work/down.err")"
ip netns exec qexit true || fail "a refused down changed the exit"
bash "$tool" verify >/dev/null || fail "a refused down left the exit unhealthy"
pass "down refuses while a machine is plugged in and changes nothing"
# The exit crashes: its namespace and everything in it disappear while the machine stays plugged in.
for pid in $(ip netns pids qexit); do kill -9 "$pid"; done
ip netns del qexit
sleep 0.5
connects agent 1.1.1.1 443 && fail "the machine still reaches the internet with the exit gone"
[[ $(ip netns exec agent python3 "$work/ask.py" 10.210.0.1 after.test) == none ]] || fail "names still resolve with the exit gone"
pass "with the exit gone the machine has no internet and nothing falls back"
bash "$tool" verify 2>/dev/null && fail "verify passed with the exit gone"
ip link del va0
bash "$tool" up >/dev/null
bash "$tool" dns >"$work/dns2.out" 2>&1 &
pids+=($!)
bash "$tool" log >"$work/log2.out" 2>&1 &
pids+=($!)
wait_for "ip netns exec qexit ss -lnu | grep -q '10.210.0.1:53 '"
bash "$tool" down >/dev/null || fail "down with nothing plugged in"
for part in qagent0 qx-br qx-up; do ip link show "$part" >/dev/null 2>&1 && fail "down left $part"; done
[[ -e /run/netns/qexit ]] && fail "down left the namespace"
nft list table inet qorpera_agent_exit_host >/dev/null 2>&1 && fail "down left the node's rules"
pass "with nothing plugged in, down removes everything, with its name and log services running"
echo "ALL PASSED"
