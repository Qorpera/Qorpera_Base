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
echo "52:54:00:00:10:10,10.210.0.10,agent-test" >"$QORPERA_AGENT_EXIT_STATE_DIR/dhcp-hosts/agent-test"
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
	-s "$work/udhcpc.sh" >/dev/null 2>&1 || fail "no DHCP lease: $(tail -5 "$work/dns.out")"
grep -q "ip=10.210.0.10 router=10.210.0.1 dns=10.210.0.1" "$work/lease" || fail "lease: $(cat "$work/lease")"
ip -n agent addr add 10.210.0.10/16 dev eth0
ip -n agent route add default via 10.210.0.1
pass "DHCP gives the machine its static address, the exit as router and as DNS"

[[ $(ip netns exec agent python3 "$work/ask.py" 10.210.0.1 example.test) == 1.1.1.1 ]] || fail "DNS through the exit"
[[ $(ip netns exec agent python3 "$work/ask.py" 8.8.8.8 other.test) == 1.1.1.1 ]] || fail "DNS to another resolver is not redirected"
wait_for "grep -q 'query\[A\] example.test from 10.210.0.10' $work/dns.out"
wait_for "grep -q 'query\[A\] other.test from 10.210.0.10' $work/dns.out"
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
ip netns exec qexit nft list set inet qorpera_agent_exit new_by_client | grep -Eq '10\.210\.0\.10 counter packets [1-9]' ||
	fail "new connections are not counted per client: $(ip netns exec qexit nft list set inet qorpera_agent_exit new_by_client)"
pass "new connections are counted per client"

# --- The log ------------------------------------------------------------------------------------------------------
ip netns exec qexit conntrack -F >/dev/null 2>&1
wait_for "ls $QORPERA_AGENT_EXIT_LOG_DIR/flows-*.jsonl >/dev/null 2>&1 && grep -q '\"event\":\"destroy\"' $QORPERA_AGENT_EXIT_LOG_DIR/flows-*.jsonl"
log_file=$(ls "$QORPERA_AGENT_EXIT_LOG_DIR"/flows-*.jsonl | head -1)
python3 - "$log_file" <<'EOF' || fail "log: $(cat "$log_file")"
import json, sys
records = [json.loads(line) for line in open(sys.argv[1])]
site = [r for r in records if r["event"] == "destroy" and r.get("dst") == "1.1.1.1" and r.get("dport") == 443]
assert site and site[0]["src"] == "10.210.0.10" and site[0]["bytes_out"] > 0 and site[0]["bytes_in"] > 0, site
assert all(r["src"].startswith("10.210.") and r["src"] != "10.210.0.1" for r in records), "a record that is not an agent's"
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

# --- Fail closed ----------------------------------------------------------------------------------------------------
if bash "$tool" down 2>"$work/down.err"; then fail "down went ahead with a machine plugged in"; fi
grep -q "agent machines are plugged in (va0" "$work/down.err" || fail "down: $(cat "$work/down.err")"
pass "down refuses while a machine is plugged in"
bash "$tool" down --force >/dev/null
connects agent 1.1.1.1 443 && fail "the agent machine still reaches the internet with the exit down"
[[ ! -e /run/netns/qexit ]] && ! ip link show qagent0 >/dev/null 2>&1 || fail "down left the namespace or the bridge"
nft list table inet qorpera_agent_exit_host >/dev/null 2>&1 && fail "down left the node's rules"
pass "with the exit down the machine has no internet and nothing falls back; nothing is left behind"
echo "ALL PASSED"
