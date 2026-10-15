#!/usr/bin/env bash
# Root proof for the agent exit. It runs as root inside a privileged, network-less throwaway container that plays a
# node: the container's own namespace is the node, and namespaces inside it are an agent machine, the office network
# (router, NAS, node 1), a small internet (a site, a resolver, our public address) and node 1 on the tailnet. It
# builds the exit with the real tool and rules, plugs the agent machine in, and checks what reaches what. The agent
# plug's reconciler (E2) runs against a stand-in for LXD: a JSON file of instances the proof rewrites.
# qorpera-agent-exit.test.mjs builds the container and runs this file. Prints PASS lines; any failure exits 1.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tool="$here/qorpera-agent-exit.sh"
work=$(mktemp -d)
# dnsmasq drops to an unprivileged user and must still read the leases directory.
chmod 0755 "$work"
export QORPERA_AGENT_EXIT_RUN_DIR=$work/run QORPERA_AGENT_EXIT_STATE_DIR=$work/state
export QORPERA_AGENT_EXIT_LOG_DIR=$work/log QORPERA_AGENT_EXIT_UPSTREAMS=9.9.9.9
# The logs' disk floor is off here, so the proof never depends on the test machine's free space; the cap is tested.
export QORPERA_AGENT_EXIT_LOG_FLOOR_PERCENT=0
# The NAS: a mount point with its marker, as the mounted share has it (a tmpfs in this container's own mounts).
export QORPERA_AGENT_EXIT_NAS_DIR=$work/nas
mkdir "$work/nas"
mount -t tmpfs -o size=64m,mode=0755 qorpera-test-nas "$work/nas"
touch "$work/nas/.qorpera-agent-exit-logs"
# The rules reader's status (E8b): its stand-in writes it here.
export QORPERA_AGENT_EXIT_RULES_STATUS=$work/rules-status.json
pids=()
cleanup() {
	local file
	for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
	# The companies' resolvers the systemctl stand-in started.
	for file in "$work"/units/*.pid; do [[ -e $file ]] && kill -CONT "$(cat "$file")" 2>/dev/null && kill "$(cat "$file")" 2>/dev/null; done
	umount "$work/nas" 2>/dev/null || true
}
trap cleanup EXIT
# A command that stops the proof on its own (set -e) names itself.
trap 'echo "FAIL: line $LINENO: $BASH_COMMAND" >&2' ERR

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
# Whether a command's output has a line that matches: `shows PATTERN COMMAND...` (PATTERN as grep's basic one). The
# output is read whole first. Piped into `grep -q`, a command still writing after the first match dies of SIGPIPE, and
# pipefail fails the check although the line is there.
shows() {
	local out
	out=$("${@:2}") && grep -q -- "$1" <<<"$out"
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
# A public resolver stand-in: every A question is answered with 1.1.1.1, one for a name starting "two." with 1.0.0.1.
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("9.9.9.9", 53))
print("ready", flush=True)
while True:
    q, peer = s.recvfrom(512)
    i = 12
    while q[i] != 0:
        i += q[i] + 1
    question = q[12:i + 5]
    address = [1, 0, 0, 1] if q[12:16] == b"\x03two" else [1, 1, 1, 1]
    answer = b"\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x3c\x00\x04" + bytes(address)
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
cat >"$work/burst.py" <<'EOF'
import socket, sys
# UDP to argv[1] on argv[3] different ports from argv[2]: as many new refused flows.
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
for port in range(int(sys.argv[2]), int(sys.argv[2]) + int(sys.argv[3])):
    s.sendto(b"x", (sys.argv[1], port))
EOF
cat >"$work/hold.py" <<'EOF'
import socket, sys, threading
# A TCP listener on argv[1]:argv[2] that keeps every connection open.
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind((sys.argv[1], int(sys.argv[2])))
s.listen(16)
held = []
print("ready", flush=True)
while True:
    held.append(s.accept()[0])
EOF
cat >"$work/fixture.py" <<'EOF'
import json, os, sys
# The stand-in for LXD: argv[1] is the file, each further argument one instance as
# project/name:status:address:company:machine:member:host_name (member and host_name may be empty). Each has one plug
# card for its address.
instances = []
for spec in sys.argv[2:]:
    where, status, address, company, machine, member, host = spec.split(":")
    project, name = where.split("/")
    nic = {"type": "nic", "nictype": "bridged", "parent": "qagent0", "name": "eth0",
           "hwaddr": "0e:51:%02x:%02x:%02x:%02x" % tuple(int(x) for x in address.split(".")),
           "ipv6.address": "none", "security.mac_filtering": "true", "security.ipv6_filtering": "true",
           "security.port_isolation": "true"}
    config = {"user.qorpera.company_id": company, "user.qorpera.machine_id": machine}
    if member:
        config["user.qorpera.member_user_id"] = member
    if host:
        config["volatile.eth0.host_name"] = host
    instances.append({"name": name, "project": project, "status": status, "expanded_config": config,
                      "expanded_devices": {"eth0": nic}})
with open(sys.argv[1] + ".tmp", "w") as f:
    json.dump(instances, f)
os.replace(sys.argv[1] + ".tmp", sys.argv[1])
EOF
cat >"$work/age.py" <<'EOF'
import json, os, sys
# Moves every client map entry in argv[1] (except the addresses after it) two hours into the past.
for name in os.listdir(sys.argv[1]):
    if not name.endswith(".json") or name[:-5] in sys.argv[2:]:
        continue
    path = os.path.join(sys.argv[1], name)
    entry = json.load(open(path))
    entry["since"] = "2000-01-01T00:00:00Z"
    with open(path + ".tmp", "w") as f:
        json.dump(entry, f)
    os.replace(path + ".tmp", path)
EOF
cat >"$work/garp.py" <<'EOF'
import socket, struct, sys
# An ARP frame out of argv[1], always with the card's own MAC as Ethernet source: op argv[2] (1 request, 2 reply),
# sender address argv[3], sender MAC argv[4] (default: the card's own).
iface, op, ip = sys.argv[1], int(sys.argv[2]), socket.inet_aton(sys.argv[3])
own = bytes.fromhex(open("/sys/class/net/%s/address" % iface).read().strip().replace(":", ""))
sha = bytes.fromhex(sys.argv[4].replace(":", "")) if len(sys.argv) > 4 else own
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
s.bind((iface, 0))
s.send(b"\xff" * 6 + own + b"\x08\x06" + struct.pack("!HHBBH", 1, 0x0800, 6, 4, op) + sha + ip + b"\xff" * 6 + ip)
EOF
cat >"$work/frame.py" <<'EOF'
import socket, sys
# One Ethernet frame out of argv[1] with the source MAC argv[2] (a broadcast IPv4 frame with a junk payload).
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
s.bind((sys.argv[1], 0))
s.send(b"\xff" * 6 + bytes.fromhex(sys.argv[2].replace(":", "")) + b"\x08\x00" + b"\x45" + b"\x00" * 45)
EOF
cat >"$work/lldp.py" <<'EOF'
import socket, struct, sys
# A UDP datagram from argv[2] to argv[3]:argv[4] in a frame to the LLDP group address, out of argv[1], from the card's
# own MAC or argv[5].
def csum(b):
    s = sum(struct.unpack("!%dH" % (len(b) // 2), b))
    while s >> 16:
        s = (s & 0xffff) + (s >> 16)
    return ~s & 0xffff
iface, src, dst, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
own = bytes.fromhex(open("/sys/class/net/%s/address" % iface).read().strip().replace(":", ""))
if len(sys.argv) > 5:
    own = bytes.fromhex(sys.argv[5].replace(":", ""))
udp = struct.pack("!HHHH", 40000, port, 12, 0) + b"lldp"
ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 32, 7, 0, 64, 17, 0, socket.inet_aton(src), socket.inet_aton(dst))
ip = ip[:10] + struct.pack("!H", csum(ip)) + ip[12:]
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW)
s.bind((iface, 0))
s.send(bytes.fromhex("0180c200000e") + own + b"\x08\x00" + ip + udp)
EOF
cat >"$work/decline.py" <<'EOF'
import socket, struct, sys
# A DHCPDECLINE to the exit from this machine's own address argv[1], naming another machine: chaddr argv[2], the address
# it declines argv[3].
chaddr = bytes.fromhex(sys.argv[2].replace(":", ""))
zero = b"\0" * 4
bootp = struct.pack("!BBBBIHH4s4s4s4s", 1, 1, 6, 0, 0x5150, 0, 0, zero, zero, zero, zero) + chaddr + b"\0" * 202
options = bytes([53, 1, 4, 50, 4]) + socket.inet_aton(sys.argv[3]) + bytes([54, 4]) + socket.inet_aton("10.210.0.1")
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind((sys.argv[1], 68))
s.sendto(bootp + b"\x63\x82\x53\x63" + options + bytes([255]), ("10.210.0.1", 67))
EOF
cat >"$work/udhcpc.sh" <<'EOF'
#!/bin/sh
[ "$1" = bound ] && echo "ip=$ip router=$router dns=$dns" > "$LEASE_FILE"
exit 0
EOF
chmod +x "$work/udhcpc.sh"
cat >"$work/rcode.py" <<'EOF'
import socket, struct, sys
# One A question for argv[2] to argv[1] (port argv[3], default 53; from port argv[4] if given). Prints the answer's code
# and first address ("NOERROR 1.1.1.1", "NOERROR none", "NXDOMAIN", ...), or "no answer".
server, name = sys.argv[1], sys.argv[2]
q = struct.pack("!HHHHHH", 0x2468, 0x0100, 1, 0, 0, 0)
q += b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\x00" + struct.pack("!HH", 1, 1)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
if len(sys.argv) > 4:
    s.bind(("0.0.0.0", int(sys.argv[4])))
s.settimeout(2)
try:
    s.sendto(q, (server, int(sys.argv[3]) if len(sys.argv) > 3 else 53))
    r, _ = s.recvfrom(512)
except OSError:
    print("no answer")
    sys.exit(0)
code = r[3] & 0x0F
if code == 0:
    print("NOERROR " + (".".join(str(b) for b in r[-4:]) if struct.unpack("!H", r[6:8])[0] else "none"))
else:
    print({2: "SERVFAIL", 3: "NXDOMAIN", 5: "REFUSED"}.get(code, "RCODE%d" % code))
EOF
cat >"$work/rules-reader.py" <<'EOF'
import datetime, json, os, sys, time
# The rules reader's stand-in (E8b-1 reads the rules from the database): every 0.3 seconds it writes the rules of each
# company with a machine in the client map argv[1] to argv[2] as the reader does, taken from argv[3] ({company: rules};
# a company not in it has none), and its status to argv[4]. While argv[3].pause exists it writes nothing at all; while
# argv[3].fail exists its status says it cannot reach the database, and the rules file stays as it is.
clients, rules_path, db_path, status_path = sys.argv[1:5]
def iso(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
def write(path, text, mode):
    with open(path + ".tmp", "w") as f:
        f.write(text)
    os.chmod(path + ".tmp", mode)
    os.replace(path + ".tmp", path)
read_at = None
print("ready", flush=True)
while True:
    if not os.path.exists(db_path + ".pause"):
        now, ok = time.time(), not os.path.exists(db_path + ".fail")
        companies = set()
        for name in os.listdir(clients):
            try:
                companies.add(json.load(open(os.path.join(clients, name)))["company"])
            except (OSError, ValueError, KeyError):
                pass
        if ok:
            db = json.load(open(db_path))
            text = json.dumps({"schema": "qorpera.agent-exit-rules/v1",
                               "companies": {c: db.get(c) for c in sorted(companies)}}, sort_keys=True) + "\n"
            try:
                same = open(rules_path).read() == text
            except FileNotFoundError:
                same = False
            if not same:
                write(rules_path, text, 0o600)
            read_at = iso(now)
        write(status_path, json.dumps({"schema": "qorpera.agent-exit-rules-status/v1", "checkedAt": iso(now),
                                       "readAt": read_at, "ok": ok, "problem": None if ok else "DB_UNREACHABLE",
                                       "companies": len(companies)}) + "\n", 0o644)
    time.sleep(0.3)
EOF
cat >"$work/db.py" <<'EOF'
import json, os, sys, uuid
# Sets companies' rules in the rules reader's stand-in database argv[1]; each further argument is company=null (no
# rules), company=bad (rules not as the reader writes them), company=a,b (open, these names blocked, none if empty) or
# company=only:a,b (only listed: listed.test allowed, these blocked) or company=only:a,b+c,d (c and d allowed). Each change
# is a new version.
path = sys.argv[1]
db = json.load(open(path))
for spec in sys.argv[2:]:
    company, value = spec.split("=", 1)
    if value == "null":
        db.pop(company, None)
    elif value == "bad":
        db[company] = {"version": "1", "mode": "open", "block": [], "allow": []}
    else:
        mode = "only-listed" if value.startswith("only:") else "open"
        value, _, allowed = value.removeprefix("only:").partition("+")
        names = [n for n in value.split(",") if n]
        db[company] = {"version": str(uuid.uuid4()), "mode": mode, "block": names,
                       "allow": (allowed.split(",") if allowed else ["listed.test"]) if mode == "only-listed" else []}
with open(path + ".tmp", "w") as f:
    json.dump(db, f)
os.replace(path + ".tmp", path)
EOF
cat >"$work/systemctl" <<'EOF'
#!/usr/bin/env bash
# systemd's part for the names reconciler, as a stand-in: argv is the exit tool, then systemctl's own. A resolver unit
# runs `qorpera-agent-exit.sh resolver PORT` in the background, with its pid (dnsmasq's: the tool execs it) in
# units/PORT.pid; a unit whose process is gone is failed.
tool=$1
shift
units=$(dirname "$0")/units
mkdir -p "$units"
alive() {
	local state
	[[ -e $units/$1.pid ]] && state=$(ps -o stat= -p "$(cat "$units/$1.pid")") && [[ $state != Z* ]]
}
port_of() { [[ $1 =~ ^qorpera-agent-exit-resolver@([0-9]+)\.service$ ]] && echo "${BASH_REMATCH[1]}"; }
start() {
	alive "$1" && return 0
	bash "$tool" resolver "$1" </dev/null >>"$units/$1.out" 2>&1 &
	echo $! >"$units/$1.pid"
}
stop() {
	if alive "$1"; then
		kill "$(cat "$units/$1.pid")"
		for _ in $(seq 1 25); do alive "$1" || break; sleep 0.2; done
	fi
	rm -f "$units/$1.pid"
}
unit=${*: -1}
port=$(port_of "$unit") || [[ $1 == list-units ]] || { echo "systemctl stand-in: not a resolver: $unit" >&2; exit 5; }
case $1 in
list-units)
	for file in "$units"/*.pid; do
		[[ -e $file ]] || continue
		port=$(basename "$file" .pid)
		if alive "$port"; then state="active running"; else state="failed failed"; fi
		echo "qorpera-agent-exit-resolver@$port.service loaded $state stand-in"
	done
	;;
start) start "$port" ;;
restart) stop "$port" && start "$port" ;;
stop) stop "$port" ;;
reload) alive "$port" && kill -HUP "$(cat "$units/$port.pid")" || { echo "$unit is not active" >&2; exit 1; } ;;
reset-failed) alive "$port" || rm -f "$units/$port.pid" ;;
*)
	echo "systemctl stand-in: $*" >&2
	exit 1
	;;
esac
EOF

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
# Where the kernel has br_netfilter (the nodes do), bridged traffic passes the node's IP hooks, as on a node.
br_netfilter=0
if [[ -e /proc/sys/net/bridge/bridge-nf-call-iptables ]]; then
	sysctl -qw net.bridge.bridge-nf-call-iptables=1
	br_netfilter=1
fi
ip link set lo up
ip netns add lan
ip -n lan link set lo up
ip link add lan0 type veth peer name lan1 netns lan
ip addr add 192.168.1.42/24 dev lan0
ip link set lan0 up
ip route replace default via 192.168.1.1
for address in 192.168.1.1/24 192.168.1.40/24 192.168.1.27/24; do ip -n lan addr add "$address" dev lan1; done
ip -n lan link set lan1 up
for address in 1.1.1.1/32 1.0.0.1/32 9.9.9.9/32 93.164.62.162/32; do ip -n lan addr add "$address" dev lo; done
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
background lan "$work/hold.out" python3 "$work/hold.py" 1.1.1.1 8443
background lan "$work/hold2.out" python3 "$work/hold.py" 1.0.0.1 443
background tail "$work/tail.out" python3 "$work/serve.py" "$work/tail-peers" 100.75.4.70:22

# --- The exit ---------------------------------------------------------------------------------------------------
# A creator as on a node: a member of the plug group, with the creators' umask (their units have UMask=0077).
groupadd --system qorpera-agent-plug
useradd --system --no-create-home --groups qorpera-agent-plug creator
as_creator() { setpriv --reuid=creator --regid=creator --init-groups -- sh -c 'umask 077; exec "$@"' sh "$@"; }
bash "$tool" check >"$work/check.out" || fail "check: $(cat "$work/check.out")"
pass "check: rules parse and the tools are present"
# The exit's database login (E8b): from stdin into a root-only file, as the rollout script sends it; it prints the
# file's sha256, never the login, and refuses anything else with the old file kept.
export QORPERA_AGENT_EXIT_LOGIN_DIR=$work/login
login='postgresql://qorpera_agent_exit.abcdefghij0123456789:Zq7_xW-ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3Wx'
login+='@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=verify-full'
out=$(printf '%s' "$login" | bash "$tool" database-url)
login_sha256=$(printf '%s' "$login" | sha256sum | cut -d' ' -f1)
[[ $out == "$work/login/database-url mode=400 owner=root:root bytes=${#login} sha256=$login_sha256" ]] ||
	fail "database-url: $out"
[[ $(stat -c '%a %U:%G' "$work/login") == "700 root:root" ]] || fail "the login folder is not root's alone"
for bad in "${login/verify-full/require}" "${login/qorpera_agent_exit/postgres}" "${login/5432/5432\/x}" \
	"$login"$'\nx' "${login/Zq7_/Zq7%}" ""; do
	if printf '%s' "$bad" | bash "$tool" database-url >"$work/login.out" 2>&1; then fail "database-url took: $bad"; fi
	grep -q 'Zq7' "$work/login.out" && fail "database-url printed the login"
done
[[ $(cat "$work/login/database-url") == "$login" && $(ls -A "$work/login") == database-url ]] ||
	fail "a refused login changed the login folder"
pass "database-url: the login from stdin into a root-only 0400 file; prints its sha256; refuses any other form"
bash "$tool" up >/dev/null
bash "$tool" up >/dev/null || fail "a second up must repair, not fail"
pass "up twice"
if bash "$tool" verify 2>"$work/verify.err"; then fail "verify passed without DNS and the logger"; fi
grep -q "no DNS on 10.210.0.1:53" "$work/verify.err" || fail "verify: $(cat "$work/verify.err")"
grep -q "logger not running" "$work/verify.err" || fail "verify: $(cat "$work/verify.err")"
grep -q "the brake not running" "$work/verify.err" || fail "verify: $(cat "$work/verify.err")"
grep -q "the agent plug's reconciler not running" "$work/verify.err" || fail "verify: $(cat "$work/verify.err")"
grep -q "the logs' tender has not run" "$work/verify.err" || fail "verify: $(cat "$work/verify.err")"
grep -q "the logs' shipper has not run" "$work/verify.err" || fail "verify: $(cat "$work/verify.err")"
grep -q "the names reconciler not running" "$work/verify.err" || fail "verify: $(cat "$work/verify.err")"
pass "verify fails while DNS, the logger (and its brake), the plug's reconciler, the logs' tender and shipper and the names reconciler are not running"
# The rules reader's folder, a link into the private folder as on a node.
mkdir -p "$work/private/qorpera-agent-exit/rules"
ln -s ../private/qorpera-agent-exit/rules "$QORPERA_AGENT_EXIT_STATE_DIR/rules"

background - "$work/node.out" python3 "$work/serve.py" "$work/node-peers" 192.168.1.42:22 10.209.255.1:22
background - "$work/nodeudp.out" python3 "$work/udpseen.py" "$work/node-udp" 192.168.1.42 9999
background qexit "$work/exit.out" python3 "$work/serve.py" "$work/exit-peers" 10.210.0.1:2222

# The agent machine, plugged in as a creator does it: plug, then a card with the MAC it gave, a port of qagent0.
agent_plug=$(as_creator python3 "$here/qorpera-agent-plug.py" plug --kind machine --company c0 --machine m0 \
	--project qp --instance agent)
[[ $agent_plug == '{"address": "10.210.1.1", "hwaddr": "0e:51:0a:d2:01:01"}' ]] || fail "plug: $agent_plug"
[[ $(stat -c %a "$QORPERA_AGENT_EXIT_STATE_DIR/dhcp-hosts/10.210.1.1") == 644 ]] ||
	fail "a creator's lease is not readable by dnsmasq: $(ls -l "$QORPERA_AGENT_EXIT_STATE_DIR/dhcp-hosts")"
ip link add va0 type veth peer name eth0 netns agent
ip -n agent link set eth0 address 0e:51:0a:d2:01:01
ip link set va0 master qagent0 up
ip -n agent link set eth0 up

bash "$tool" dns >"$work/dns.out" 2>&1 &
pids+=($!)
wait_for "shows '10.210.0.1:53 ' ip netns exec qexit ss -lnu"
bash "$tool" log >"$work/log.out" 2>&1 &
logger_pid=$!
pids+=($!)
wait_for "test -e $QORPERA_AGENT_EXIT_RUN_DIR/logger.heartbeat"
bash "$tool" logs >"$work/logs.out" || fail "the logs' tender: $(cat "$work/logs.out")"
bash "$tool" ship >"$work/ship.out" || fail "the logs' shipper: $(cat "$work/ship.out")"
AGENT="qp/agent:Running:10.210.1.1:c0:m0::va0"
python3 "$work/fixture.py" "$work/lxd.json" "$AGENT"
# The dns unit's reload: the main dnsmasq alone (its --dhcp-range is its own), not the companies' resolvers.
QORPERA_AGENT_PLUG_LXD_FIXTURE=$work/lxd.json QORPERA_AGENT_PLUG_RELOAD_DNS="pkill -HUP -f -- --dhcp-range=" \
	QORPERA_AGENT_PLUG_INTERVAL=0.3 bash "$tool" plug >"$work/plug.out" 2>&1 &
pids+=($!)
wait_for "test -e $QORPERA_AGENT_EXIT_RUN_DIR/plug.json"
# The names reconciler (E8b), with the rules reader's stand-in (the companies' rules from a JSON file the proof
# rewrites, db-rules.json) and systemd's (the resolver units).
clients_dir=$QORPERA_AGENT_EXIT_STATE_DIR/clients
rules_file=$QORPERA_AGENT_EXIT_STATE_DIR/rules/rules.json
db=$work/db-rules.json
echo '{}' >"$db"
background - "$work/rules.out" python3 "$work/rules-reader.py" "$clients_dir" "$rules_file" "$db" "$work/rules-status.json"
QORPERA_AGENT_EXIT_NAMES_INTERVAL=0.3 QORPERA_AGENT_EXIT_SYSTEMCTL="bash $work/systemctl $tool" \
	bash "$tool" names >"$work/names.out" 2>&1 &
names_pid=$!
pids+=($!)
names_get() { python3 -c 'import json, sys; s = json.load(open(sys.argv[1])); print(json.dumps(eval(sys.argv[2])))' "$QORPERA_AGENT_EXIT_RUN_DIR/names.json" "$1"; }
names_is() { [[ $(names_get "$1" 2>/dev/null) == true ]]; }
wait_for "names_is \"s['mapped'] == {'10.210.1.1': 53} and s['problems'] == []\""
bash "$tool" verify >/dev/null || fail "verify with everything running: $(bash "$tool" verify 2>&1)"
bash "$tool" health || fail "health: $(cat "$QORPERA_AGENT_EXIT_RUN_DIR/health.json")"
grep -q '"healthy": true' "$QORPERA_AGENT_EXIT_RUN_DIR/health.json" || fail "health: $(cat "$QORPERA_AGENT_EXIT_RUN_DIR/health.json")"
[[ $(stat -c %a "$rules_file") == 600 ]] || fail "the rules file: $(ls -l "$rules_file")"
pass "verify passes with DNS, the logger, the plug's and the names reconcilers running, and health says so for the observer"

# --- DHCP and names -----------------------------------------------------------------------------------------------
LEASE_FILE=$work/lease ip netns exec agent env LEASE_FILE="$work/lease" busybox udhcpc -i eth0 -n -q -f -t 5 -T 1 \
	-s "$work/udhcpc.sh" >/dev/null 2>&1 || fail "no DHCP lease: $(tail -5 "$QORPERA_AGENT_EXIT_LOG_DIR/dns.log" 2>&1)"
grep -q "ip=10.210.1.1 router=10.210.0.1 dns=10.210.0.1" "$work/lease" || fail "lease: $(cat "$work/lease")"
ip -n agent addr add 10.210.1.1/16 dev eth0
ip -n agent route add default via 10.210.0.1
pass "DHCP gives the machine its static address, the exit as router and as DNS"

[[ $(ip netns exec agent python3 "$work/ask.py" 10.210.0.1 example.test) == 1.1.1.1 ]] || fail "DNS through the exit"
[[ $(ip netns exec agent python3 "$work/ask.py" 8.8.8.8 other.test) == 1.1.1.1 ]] || fail "DNS to another resolver is not redirected"
wait_for "grep -q 'query\[A\] example.test from 10.210.1.1' $QORPERA_AGENT_EXIT_LOG_DIR/dns.log"
wait_for "grep -q 'query\[A\] other.test from 10.210.1.1' $QORPERA_AGENT_EXIT_LOG_DIR/dns.log"
pass "names resolve through the exit, plain DNS elsewhere is redirected, and every query is logged"

# --- What reaches what --------------------------------------------------------------------------------------------
connects agent 1.1.1.1 443 || fail "the agent machine cannot reach a website"
wait_for "grep -q '1.1.1.1:443 192.168.1.42' $work/lan-peers"
grep -q '1.1.1.1:443 10\.' "$work/lan-peers" && fail "a site saw an inside address"
pass "a website is reached, and sees the node's address (phase 1)"
# A connection the site closes first: both tables hold it in TIME_WAIT for at most 30 seconds (the kernel's default
# is 120).
time_wait_left() { "$@" conntrack -L -p tcp --state TIME_WAIT -d 1.1.1.1 2>/dev/null | awk '$4 == "TIME_WAIT" {print $3}' | sort -n | tail -1; }
# Read the greeting, then close: an unread greeting would make the close a reset (CLOSE, not TIME_WAIT).
ip netns exec agent python3 -c 'import socket; s = socket.create_connection(("1.1.1.1", 443), 3); s.recv(16); s.close()' ||
	fail "the agent machine cannot reach a website"
wait_for "[[ -n \$(time_wait_left ip netns exec qexit) ]]"
exit_left=$(time_wait_left ip netns exec qexit)
wait_for "[[ -n \$(time_wait_left) ]]"
node_left=$(time_wait_left)
((exit_left <= 30 && node_left <= 30)) || fail "a closed agent connection is held ${exit_left}s in the exit and ${node_left}s on the node"
pass "a closed agent connection is held at most 30 seconds in both tables (exit ${exit_left}s, node ${node_left}s left)"
if ((br_netfilter)); then
	shows 'dport=443' ip netns exec qexit conntrack -L -s 10.210.1.1 2>/dev/null || fail "the exit did not track the connection"
	host_legs=$(conntrack -L -s 10.210.1.1 2>/dev/null | grep -c . || true)
	((host_legs == 0)) || fail "the node tracks bridged agent traffic: $(conntrack -L -s 10.210.1.1 2>&1)"
	pass "with br_netfilter, the exit tracks the connection and the node does not track the bridged leg"
else
	echo "SKIP: br_netfilter is not loaded here (the nodes have it); E2's proof on LXD covers the node's table"
fi
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
# The gateway's MAC as a static neighbour: no ARP is involved, so what follows tests the IPv4 rules alone.
exit_mac=$(ip -n qexit -br link show br0 | awk '{print $3}')
ip -n agent neigh replace 10.210.0.1 lladdr "$exit_mac" dev eth0 nud permanent
ip -n agent addr add 172.20.0.5/32 dev eth0
ip -n agent addr add 10.210.1.200/32 dev eth0
[[ $(ip netns exec agent python3 "$work/from.py" 172.20.0.5 1.1.1.1 443) == closed ]] || fail "a spoofed source got out"
[[ $(ip netns exec agent python3 "$work/from.py" 10.210.1.200 1.1.1.1 443) == closed ]] ||
	fail "a machine got out with another agent address than its own"
shows 'packets [1-9]' nft list counter bridge qorpera_agent_exit_bridge dropped_unbound || fail "spoofed not counted"
shows '10.210.1.200' ip netns exec qexit nft list set inet qorpera_agent_exit new_by_client &&
	fail "the exit saw a connection from an address that is not the machine's"
shows . ip netns exec qexit conntrack -L -s 10.210.1.200 2>/dev/null && fail "the exit tracked a spoofed address"
ip -n agent addr del 10.210.1.200/32 dev eth0
pass "the bridge drops a source that is not the machine's own address, in the agent range or outside it"
# A card whose MAC is not in the client map gets no address and gets nowhere.
ip netns add rogue
ip link add vr0 type veth peer name eth0 netns rogue
ip -n rogue link set eth0 address 0e:51:0a:d2:01:fe
ip link set vr0 master qagent0 up
ip -n rogue link set eth0 up
ip netns exec rogue busybox udhcpc -i eth0 -n -q -f -t 2 -T 1 -s /bin/true >/dev/null 2>&1 && fail "a card outside the map got a lease"
ip -n rogue addr add 10.210.1.254/16 dev eth0
ip -n rogue route add default via 10.210.0.1
connects rogue 1.1.1.1 443 && fail "a card outside the map reached the internet"
ip link del vr0
ip netns del rogue
pass "a card outside the client map gets no address and no internet"
# LLDP-addressed frames skip the bridge's hooks unless forwarded through them; then the exit refuses the node.
ip netns exec agent python3 "$work/lldp.py" eth0 10.210.1.1 192.168.1.42 9999
sleep 1
[[ -s $work/node-udp ]] && fail "an LLDP-addressed frame reached the node: $(cat "$work/node-udp")"
# Link-local frames would otherwise teach the bridge any MAC they carry, before any hook.
unbound_before=$(nft list counter bridge qorpera_agent_exit_bridge dropped_unbound | grep -o 'packets [0-9]*' | cut -d' ' -f2)
ip netns exec agent python3 "$work/lldp.py" eth0 10.210.1.1 192.168.1.42 9999 0e:51:0a:d2:01:ee
sleep 0.5
shows 0e:51:0a:d2:01:ee bridge fdb show br qagent0 && fail "an LLDP-addressed frame taught the bridge a MAC"
# Dropped by the bridge rules, so it went through them (group_fwd_mask): without it the counter would not move.
unbound_after=$(nft list counter bridge qorpera_agent_exit_bridge dropped_unbound | grep -o 'packets [0-9]*' | cut -d' ' -f2)
((unbound_after > unbound_before)) || fail "an LLDP-addressed frame did not go through the bridge rules"
pass "an LLDP-addressed frame from a machine reaches nothing on the node and teaches the bridge no MAC"
ip netns exec agent python3 "$work/raw.py" 10.210.1.1 192.168.1.40 253
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
shows lladdr ip -n agent neigh show 192.168.1.42 && fail "the node answered ARP on the agents' bridge: $(ip -n agent neigh show 192.168.1.42)"
ip -n agent route del 192.168.1.42/32
pass "the node does not answer ARP on the agents' bridge"
shows '10\.210\.1\.1 counter packets [1-9]' ip netns exec qexit nft list set inet qorpera_agent_exit new_by_client ||
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
assert site and site[0]["src"] == "10.210.1.1" and site[0]["bytes_out"] > 0 and site[0]["bytes_in"] > 0, site
assert all(r["src"].startswith("10.210.") and r["src"] != "10.210.0.1" for r in records if r["event"] not in ("gap", "alive")), "not an agent's"

EOF
for _ in $(seq 1 50); do
	grep -q '"dst":"192.168.1.40","event":"refused".*"rule":"our_networks"' "$log_file" && break
	sleep 0.2
done
grep -q '"dst":"192.168.1.40","event":"refused".*"rule":"our_networks"' "$log_file" || fail "no refused flow (with its rule) in the log.
logger: $(cat "$work/log.out")
set: $(ip netns exec qexit nft -j list set inet qorpera_agent_exit refused_flows 2>&1)
log: $(cat "$log_file")"
pass "the log has each connection's end with bytes, and the refused flows, for agent machines only"
# Past a machine's share (a burst of 100 new refused flows), refusals are counted as unlogged and become a gap line.
ip netns exec agent python3 "$work/burst.py" 192.168.1.40 20000 150
for _ in $(seq 1 50); do grep -q '"event":"gap".*unlogged flows' "$log_file" && break; sleep 0.2; done
grep -q '"event":"gap".*unlogged flows' "$log_file" || fail "no gap line for unlogged refusals: $(tail -5 "$log_file")"
grep -q 'cannot read' "$log_file" && fail "the logger failed to read the exit's sets: $(grep 'cannot read' "$log_file")"
pass "refusals past a machine's share show as a gap, and the logger read every set"

# --- The agent plug (E2) ---------------------------------------------------------------------------------------
plug_tool=$here/qorpera-agent-plug.py
clients_dir=$QORPERA_AGENT_EXIT_STATE_DIR/clients
client_history() { cat "$QORPERA_AGENT_EXIT_LOG_DIR"/clients-*.jsonl 2>/dev/null || true; }
problems() { python3 -c 'import json, sys; print("\n".join(json.load(open(sys.argv[1]))["problems"]))' "$QORPERA_AGENT_EXIT_RUN_DIR/plug.json"; }
first=$(as_creator python3 "$plug_tool" plug --kind coding --company c1 --machine m1 --member u1 --project qp --instance vm1)
[[ $first == '{"address": "10.210.1.2", "hwaddr": "0e:51:0a:d2:01:02"}' ]] || fail "plug: $first"
again=$(as_creator python3 "$plug_tool" plug --kind coding --company c1 --machine m1 --member u1 --project qp --instance vm1)
[[ $again == "$first" ]] || fail "a repeated plug gave $again"
second=$(python3 "$plug_tool" plug --kind machine --company c2 --machine m2 --project qp --instance vm2)
[[ $second == *'"10.210.1.3"'* ]] || fail "second plug: $second"
if python3 "$plug_tool" plug --kind machine --company c3 --machine m3 --project qp --instance vm1 2>"$work/conflict.err"; then
	fail "a plug took another machine's instance"
fi
grep -q "already plugged in for another machine" "$work/conflict.err" || fail "conflict: $(cat "$work/conflict.err")"
[[ $(cat "$QORPERA_AGENT_EXIT_STATE_DIR/dhcp-hosts/10.210.1.2") == "0e:51:0a:d2:01:02,10.210.1.2" ]] || fail "lease file"
race=()
for i in $(seq 10 29); do
	python3 "$plug_tool" plug --kind machine --company c --machine "m$i" --project qp --instance "race$i" >"$work/race$i" &
	race+=($!)
done
wait "${race[@]}"
[[ $(cat "$work"/race* | sort -u | wc -l) == 20 ]] || fail "twenty plugs at once did not get twenty addresses: $(cat "$work"/race*)"
pass "plug gives the lowest free address and its MAC, the same again for the same machine and never another's"
pass "twenty plugs at once get twenty addresses"

ip netns add plugged
ip -n plugged link set lo up
ip link add pv0 type veth peer name eth0 netns plugged
ip -n plugged link set eth0 address 0e:51:0a:d2:01:02
ip link set pv0 master qagent0 up
ip -n plugged link set eth0 up
# Until LXD backs it, nothing from its card passes.
ip netns exec plugged busybox udhcpc -i eth0 -n -q -f -t 2 -T 1 -s /bin/true >/dev/null 2>&1 &&
	fail "a plugged card LXD does not back yet got a lease"
python3 "$work/fixture.py" "$work/lxd.json" "$AGENT" "qp/vm1:Running:10.210.1.2:c1:m1:u1:pv0"
wait_for "shows '\"address\":\"10.210.1.2\",\"company\":\"c1\",\"event\":\"plugged\"' client_history"
LEASE_FILE=$work/lease2 ip netns exec plugged env LEASE_FILE="$work/lease2" busybox udhcpc -i eth0 -n -q -f -t 5 -T 1 \
	-s "$work/udhcpc.sh" >/dev/null 2>&1 || fail "no DHCP lease for the plugged machine"
grep -q "ip=10.210.1.2 router=10.210.0.1" "$work/lease2" || fail "lease: $(cat "$work/lease2")"
ip -n plugged addr add 10.210.1.2/16 dev eth0
ip -n plugged route add default via 10.210.0.1
wait_for "bash $tool verify >/dev/null 2>&1"
pass "a plugged machine gets nothing until LXD backs it, then its address by DHCP; the exit stays healthy"

python3 "$work/fixture.py" "$work/lxd.json" "$AGENT" "qp/vm1:Running:10.210.1.2:c9:m1:u1:pv0" \
	"qp/stray:Running:10.210.1.99:c1:m9::" "qp/vm2:Running:10.210.1.3:c2:m2::nope0"
wait_for "shows stray problems"
problems >"$work/problems"
grep -q "qp/vm1 (10.210.1.2): user.qorpera.company_id is 'c9', not 'c1'" "$work/problems" || fail "problems: $(cat "$work/problems")"
grep -q "qp/stray is on qagent0 without a client map entry" "$work/problems" || fail "problems: $(cat "$work/problems")"
grep -q "qp/vm2 (10.210.1.3) is running, but its network card (nope0) is not a port of qagent0" "$work/problems" ||
	fail "problems: $(cat "$work/problems")"
bash "$tool" health && fail "health said healthy with a wrong machine on the bridge"
grep -q "stray is on qagent0" "$QORPERA_AGENT_EXIT_RUN_DIR/health.json" || fail "health: $(cat "$QORPERA_AGENT_EXIT_RUN_DIR/health.json")"
shows '"address":"10.210.1.2","company":"c1","event":"mismatch".*"c9"' client_history || fail "no mismatch line: $(client_history)"
shows '"event":"unattributed".*"instance":"stray"' client_history || fail "no unattributed line: $(client_history)"
python3 "$work/fixture.py" "$work/lxd.json" "$AGENT" "qp/vm1:Running:10.210.1.2:c1:m1:u1:pv0"
wait_for "bash $tool verify >/dev/null 2>&1"
pass "a card or identity unlike its entry, a machine without an entry and a card off the bridge make the exit unhealthy"

# A forged entry: a creator claims company cF for a machine LXD says is company cR's. Unhealthy, logged, never
# attributed; when the machine goes, the entry is dropped, never unplugged.
forged=$(as_creator python3 "$plug_tool" plug --kind machine --company cF --machine mF --project qp --instance real1)
[[ $forged == *'"10.210.1.24"'* ]] || fail "forged plug: $forged"
python3 "$work/fixture.py" "$work/lxd.json" "$AGENT" "qp/vm1:Running:10.210.1.2:c1:m1:u1:pv0" "qp/real1:Stopped:10.210.1.24:cR:mF::"
wait_for "shows \"qp/real1 (10.210.1.24): user.qorpera.company_id is 'cR', not 'cF'\" problems"
bash "$tool" verify >/dev/null 2>&1 && fail "verify passed with a forged entry"
shows '"address":"10.210.1.24","company":"cF","event":"mismatch".*"cR"' client_history || fail "no mismatch line: $(client_history)"
python3 "$work/fixture.py" "$work/lxd.json" "$AGENT" "qp/vm1:Running:10.210.1.2:c1:m1:u1:pv0"
wait_for "test ! -e $clients_dir/10.210.1.24.json"
shows '"address":"10.210.1.24","company":"cF","event":"dropped"' client_history || fail "no dropped line: $(client_history)"
shows '"address":"10.210.1.24","company":"cF","event":"plugged"' client_history && fail "a forged entry was attributed"
wait_for "bash $tool verify >/dev/null 2>&1"
pass "a forged entry makes the exit unhealthy, is logged as a mismatch, and is never attributed to the company it names"

ip netns exec plugged python3 -c 'import socket, time; s = socket.create_connection(("1.1.1.1", 8443)); time.sleep(600)' &
pids+=($!)
ip netns exec plugged busybox ping -c 1 -W 1 1.1.1.1 >/dev/null || fail "the plugged machine cannot ping a site"
ip netns exec plugged python3 "$work/udp.py" 1.1.1.1 9999
wait_for "shows 'dport=8443' ip netns exec qexit conntrack -L -s 10.210.1.2 2>/dev/null"
for twin in "-p tcp --dport 8443" "-p udp --dport 9999" "-p icmp"; do
	wait_for "shows 1.1.1.1 conntrack -L -s 10.209.255.2 -d 1.1.1.1 $twin 2>/dev/null"
done
# Spoofing from one plugged card (the agent machine, 10.210.1.1) against another (10.210.1.2), whose MAC the exit knows.
wait_for "shows 0e:51:0a:d2:01:02 ip -n qexit neigh show 10.210.1.2"
for op in 1 2; do ip netns exec agent python3 "$work/garp.py" eth0 "$op" 10.210.1.2; done
ip netns exec agent python3 "$work/garp.py" eth0 2 10.210.1.1 0e:51:0a:d2:01:02
ip netns exec agent python3 "$work/decline.py" 10.210.1.1 0e:51:0a:d2:01:02 10.210.1.2
sleep 1
shows 0e:51:0a:d2:01:02 ip -n qexit neigh show 10.210.1.2 || fail "gratuitous ARP moved another machine's address: $(ip -n qexit neigh)"
shows 0e:51:0a:d2:01:02 ip -n qexit neigh show 10.210.1.1 && fail "an ARP sender MAC moved the agent's address: $(ip -n qexit neigh)"
grep -q DHCPDECLINE "$QORPERA_AGENT_EXIT_LOG_DIR/dns.log" && fail "a machine declined another's lease: $(grep DHCP "$QORPERA_AGENT_EXIT_LOG_DIR/dns.log")"
new_before=$(ip netns exec qexit nft list set inet qorpera_agent_exit new_by_client | grep -o '10.210.1.1 counter packets [0-9]*')
ip -n agent link set eth0 down
ip -n agent link set eth0 address 0e:51:0a:d2:01:fd
ip -n agent link set eth0 up
ip -n agent route replace default via 10.210.0.1
ip -n agent neigh replace 10.210.0.1 lladdr "$exit_mac" dev eth0 nud permanent
connects agent 1.1.1.1 443 && fail "the agent's address got out from another MAC"
[[ $(ip netns exec qexit nft list set inet qorpera_agent_exit new_by_client | grep -o '10.210.1.1 counter packets [0-9]*') == "$new_before" ]] ||
	fail "the exit saw the agent's address from another MAC"
ip -n agent link set eth0 down
ip -n agent link set eth0 address 0e:51:0a:d2:01:01
ip -n agent link set eth0 up
ip -n agent route replace default via 10.210.0.1
ip -n agent neigh replace 10.210.0.1 lladdr "$exit_mac" dev eth0 nud permanent
wait_for "connects agent 1.1.1.1 443"
pass "no gratuitous ARP for another's address, no ARP sender MAC, no DHCP naming another's MAC, no address from another MAC"
for stolen in 0e:51:0a:d2:01:02 "$exit_mac"; do ip netns exec agent python3 "$work/frame.py" eth0 "$stolen"; done
sleep 0.5
shows "0e:51:0a:d2:01:02 dev pv0" bridge fdb show br qagent0 || fail "another machine's MAC moved: $(bridge fdb show br qagent0)"
shows "$exit_mac dev va0" bridge fdb show br qagent0 && fail "the exit's MAC moved to a machine: $(bridge fdb show br qagent0)"
pass "a machine cannot take another machine's MAC, or the exit's, on the bridge"
# A frame from the exit to a MAC the bridge has forgotten is flooded to every port; it must reach only its own.
nft add table bridge flood_count
nft add chain bridge flood_count seen '{ type filter hook forward priority 100; }'
nft add rule bridge flood_count seen oifname "pv0" ether daddr 0e:51:0a:d2:01:01 counter
bridge fdb del 0e:51:0a:d2:01:01 dev va0 master 2>/dev/null || true
shows "0e:51:0a:d2:01:01 dev va0" bridge fdb show br qagent0 && fail "the agent's MAC is still in the bridge table"
ip netns exec qexit busybox ping -c 1 -W 1 10.210.1.1 >/dev/null 2>&1 || true
shows 'packets 0 ' nft list chain bridge flood_count seen ||
	fail "the exit's frame to a forgotten MAC reached another machine: $(nft list chain bridge flood_count seen)"
nft delete table bridge flood_count
pass "a frame from the exit to a MAC the bridge has forgotten reaches no other machine"
# Machine to machine: the bridge rules alone keep them apart (this proof's cards have no port isolation).
background plugged "$work/peer.out" python3 "$work/udpseen.py" "$work/peer-udp" 10.210.1.2 9999
ip -n agent neigh replace 10.210.1.2 lladdr 0e:51:0a:d2:01:02 dev eth0 nud permanent
ip netns exec agent python3 "$work/udp.py" 10.210.1.2 9999
sleep 1
[[ -s $work/peer-udp ]] && fail "a machine reached another on the bridge: $(cat "$work/peer-udp")"
ip -n agent neigh del 10.210.1.2 dev eth0
pass "a machine reaches no other machine on the bridge, even knowing its MAC"
python3 "$work/fixture.py" "$work/lxd.json" "$AGENT" "qp/vm1:Stopped:10.210.1.2:c1:m1:u1:"
wait_for "test -e $QORPERA_AGENT_EXIT_RUN_DIR/plug-stopped/10.210.1.2"
shows 1.1.1.1 ip netns exec qexit conntrack -L -s 10.210.1.2 2>/dev/null && fail "the exit kept a sleeping machine's connections"
for twin in "-p tcp --dport 8443" "-p udp --dport 9999" "-p icmp"; do
	shows 1.1.1.1 conntrack -L -s 10.209.255.2 -d 1.1.1.1 $twin 2>/dev/null && fail "the node kept a twin ($twin)"
done
[[ -e $clients_dir/10.210.1.2.json && -e $QORPERA_AGENT_EXIT_STATE_DIR/dhcp-hosts/10.210.1.2 ]] || fail "sleep lost the address"
python3 "$work/fixture.py" "$work/lxd.json" "$AGENT" "qp/vm1:Running:10.210.1.2:c1:m1:u1:pv0"
wait_for "test ! -e $QORPERA_AGENT_EXIT_RUN_DIR/plug-stopped/10.210.1.2"
pass "a sleeping machine keeps its address and entry; its TCP, UDP and ICMP connections end in the exit and on the node"

# --- Each company's names (E8b) and where its machines may go (E8c-1) ------------------------------------------------
# The agent machine is company c0's, the plugged one company c1's. A company with rules gets a resolver of its own on
# 10.210.0.1 (a port of its own), which answers "no such name" for its blocked names; one without keeps the main
# dnsmasq on 53. A machine's DNS goes to its company's, whatever address it asks. The map reach sends each machine's
# new flows to the chain open, or to its company's only_<port> in "only listed" mode.
nft_elements() {
	local text
	text=$(ip netns exec qexit nft -j list "$1" inet qorpera_agent_exit "$2")
	python3 -c '
import json, sys
found = []
for item in json.loads(sys.argv[1])["nftables"]:
    for elem in (item.get("map") or item.get("set") or {}).get("elem", []) or []:
        found.append("%s:%s" % tuple(elem if isinstance(elem, list) else elem["concat"]))
print(" ".join(sorted(found)))' "$text"
}
dns_map() { nft_elements map dns_port; }
dns_allowed() { nft_elements set dns_allowed; }
dns_is() { [[ $(dns_map) == "$1" && $(dns_allowed) == "$1" ]]; }
# The map reach as `nft -j` gives it ([address, {"goto": {"target": chain}}]): "address:chain ...".
reach_map() {
	local text
	text=$(ip netns exec qexit nft -j list map inet qorpera_agent_exit reach)
	python3 -c '
import json, sys
found = []
for item in json.loads(sys.argv[1])["nftables"]:
    for key, verdict in (item.get("map") or {}).get("elem", []) or []:
        found.append("%s:%s" % (key, verdict["goto"]["target"]))
print(" ".join(sorted(found)))' "$text"
}
counted() { ip netns exec qexit nft list counter inet qorpera_agent_exit "$1" | grep -o 'packets [0-9]*' | cut -d' ' -f2; }
refused_dns() {
	local text
	text=$(ip netns exec qexit nft list counter inet qorpera_agent_exit refused_dns)
	grep -o 'packets [0-9]*' <<<"$text" | cut -d' ' -f2
}
ask_code() {
	local ns=$1
	shift
	ip netns exec "$ns" python3 "$work/rcode.py" "$@"
}
asks() { [[ $(ask_code "$1" "$2" "$3" "${@:5}") == "$4" ]]; }
resolver_pid() { cat "$work/units/$1.pid" 2>/dev/null; }
servers_dir=$QORPERA_AGENT_EXIT_RUN_DIR/names
dns_log=$QORPERA_AGENT_EXIT_LOG_DIR/dns.log

python3 "$work/db.py" "$db" 'c0=blocked.test,*.wild.test'
wait_for "names_is \"s['resolvers'] == {'c0': 10001} and s['mapped'] == {'10.210.1.1': 10001, '10.210.1.2': 53} and s['problems'] == []\""
[[ $(stat -c %a "$servers_dir/10001.servers") == 644 &&
	$(cat "$servers_dir/10001.servers") == $'server=/*.wild.test/\nserver=/blocked.test/' ]] ||
	fail "c0's servers file: $(ls -l "$servers_dir"; cat "$servers_dir/10001.servers")"
dns_is "10.210.1.1:10001 10.210.1.2:53" || fail "the DNS map: $(dns_map) / $(dns_allowed)"
[[ $(reach_map) == "10.210.1.1:open 10.210.1.2:open" ]] || fail "the reach map: $(reach_map)"
for server in 10.210.0.1 8.8.8.8; do
	for name in blocked.test sub.blocked.test a.wild.test; do
		asks agent "$server" "$name" NXDOMAIN || fail "$name via $server: $(ask_code agent "$server" "$name")"
	done
	for name in wild.test open.test; do
		asks agent "$server" "$name" "NOERROR 1.1.1.1" || fail "$name via $server: $(ask_code agent "$server" "$name")"
	done
done
asks plugged 10.210.0.1 blocked.test "NOERROR 1.1.1.1" || fail "c1 got c0's block: $(ask_code plugged 10.210.0.1 blocked.test)"
resolver=$(resolver_pid 10001)
wait_for "grep -q 'config blocked.test is NXDOMAIN' $dns_log"
wait_for "grep -q 'dnsmasq\[$resolver\]: .*query\[A\] open.test from 10.210.1.1' $dns_log"
bash "$tool" verify >/dev/null || fail "verify with a company's resolver: $(bash "$tool" verify 2>&1)"
pass "a company with rules gets its own resolver: its blocked names and the names under them are no such name, asked of the exit or any other address; a company without rules keeps the main dnsmasq; both log to dns.log"

# A machine whose resolver changes has its DNS connections ended: a lookup from the same port goes to the new one.
asks plugged 8.8.8.8 flush.test "NOERROR 1.1.1.1" 53 40053 || fail "flush.test: $(ask_code plugged 8.8.8.8 flush.test 53 40053)"
python3 "$work/db.py" "$db" 'c1=flush.test'
wait_for "names_is \"s['resolvers'] == {'c0': 10001, 'c1': 10002} and s['mapped'] == {'10.210.1.1': 10001, '10.210.1.2': 10002} and s['problems'] == []\""
asks plugged 8.8.8.8 flush.test NXDOMAIN 53 40053 ||
	fail "a DNS connection went on to the main dnsmasq after its company got rules: $(ask_code plugged 8.8.8.8 flush.test 53 40053)"
pass "a company that gets rules moves to its own resolver, and its machines' DNS connections to the old one end"

# A new version reloads the resolver (SIGHUP: the servers file again, the cache emptied); it is not restarted.
asks agent 10.210.0.1 added.test "NOERROR 1.1.1.1" || fail "added.test: $(ask_code agent 10.210.0.1 added.test)"
python3 "$work/db.py" "$db" 'c0=blocked.test,*.wild.test,added.test'
wait_for "asks agent 10.210.0.1 added.test NXDOMAIN"
[[ $(resolver_pid 10001) == "$resolver" ]] || fail "c0's resolver was restarted, not reloaded"
names_is "s['resolvers'] == {'c0': 10001, 'c1': 10002}" || fail "the ports moved: $(names_get "s['resolvers']")"
pass "a new block applies within seconds by a reload, even for a name the resolver had cached"

# Another company's resolver cannot be asked directly; a machine's own can.
asks agent 10.210.0.1 open.test "no answer" 10002 || fail "c0's machine asked c1's resolver"
asks plugged 10.210.0.1 open.test "no answer" 10001 || fail "c1's machine asked c0's resolver"
asks plugged 10.210.0.1 flush.test NXDOMAIN 10002 || fail "c1's machine cannot ask its own resolver's port"
pass "a machine never reaches another company's resolver"

# "Only listed" (E8c-1): the resolver answers only the listed names not blocked, and puts the addresses it gives out in
# the company's set allow_10002; the machine reaches TCP 443 on those only. The switch restarts the resolver (the set
# emptied first) and ends the machine's connections, so none made before goes on.
ip netns exec plugged python3 -c 'import socket, time; s = socket.create_connection(("1.1.1.1", 8443)); time.sleep(600)' &
pids+=($!)
wait_for "shows 'dport=8443' ip netns exec qexit conntrack -L -s 10.210.1.2 2>/dev/null"
resolver2=$(resolver_pid 10002)
not_listed=$(counted refused_not_listed)
python3 "$work/db.py" "$db" 'c1=only:only.test'
wait_for "names_is \"s['reach'] == {'10.210.1.1': 'open', '10.210.1.2': 'only_10002'} and s['problems'] == []\""
[[ $(reach_map) == "10.210.1.1:open 10.210.1.2:only_10002" ]] || fail "the reach map: $(reach_map)"
[[ $(cat "$servers_dir/10002.mode") == only-listed ]] || fail "the mode file: $(cat "$servers_dir/10002.mode")"
wait_for "asks plugged 10.210.0.1 unlisted.test NXDOMAIN"
[[ $(resolver_pid 10002) != "$resolver2" ]] || fail "the switch reloaded c1's resolver; it must restart it"
resolver2=$(resolver_pid 10002)
shows 'dport=8443' ip netns exec qexit conntrack -L -s 10.210.1.2 2>/dev/null && fail "a connection made before the switch goes on"
refused_now plugged 1.1.1.1 443 || fail "an address no listed name gave reached"
asks plugged 8.8.8.8 only.test NXDOMAIN || fail "a blocked name: $(ask_code plugged 8.8.8.8 only.test)"
asks plugged 10.210.0.1 listed.test "NOERROR 1.1.1.1" || fail "a listed name: $(ask_code plugged 10.210.0.1 listed.test)"
connects plugged 1.1.1.1 443 || fail "the machine cannot reach a listed name's address"
refused_now plugged 1.0.0.1 443 || fail "an unlisted address reached"
refused_now plugged 1.1.1.1 8443 || fail "a listed address on another port reached"
ip netns exec plugged busybox ping -c 1 -W 1 1.1.1.1 >/dev/null && fail "a listed address answered a ping"
(($(counted refused_not_listed) >= not_listed + 3)) || fail "refused_not_listed: $not_listed, then $(counted refused_not_listed)"
wait_for "grep -q '\"dst\":\"1.0.0.1\",\"event\":\"refused\".*\"rule\":\"not_listed\"' $log_file"
connects agent 1.0.0.1 443 || fail "an open company's machine lost its way out"
asks plugged 10.210.0.1 two.listed.test "NOERROR 1.0.0.1" || fail "a name under a listed one: $(ask_code plugged 10.210.0.1 two.listed.test)"
ip netns exec plugged python3 -c 'import socket, time; s = socket.create_connection(("1.0.0.1", 443)); time.sleep(600)' &
pids+=($!)
wait_for "shows 'dst=1.0.0.1 sport=[0-9]* dport=443' ip netns exec qexit conntrack -L -s 10.210.1.2 2>/dev/null"
pass "only listed: unlisted names are no such name; the machine reaches TCP 443 on a listed name's addresses only, refused and logged as not_listed otherwise; the switch restarts the resolver and ends the connections made before"

# A wider list reloads the resolver; a narrower one restarts it with its set emptied and ends the connections again.
python3 "$work/db.py" "$db" 'c1=only:only.test+listed.test,more.test'
wait_for "asks plugged 10.210.0.1 more.test 'NOERROR 1.1.1.1'"
[[ $(resolver_pid 10002) == "$resolver2" ]] || fail "a wider list restarted the resolver"
shows 'dst=1.0.0.1 sport=[0-9]* dport=443' ip netns exec qexit conntrack -L -s 10.210.1.2 2>/dev/null ||
	fail "a wider list ended a connection"
python3 "$work/db.py" "$db" 'c1=only:only.test+more.test'
wait_for "asks plugged 10.210.0.1 listed.test NXDOMAIN"
[[ $(resolver_pid 10002) != "$resolver2" ]] || fail "a narrower list only reloaded the resolver"
wait_for "names_is \"s['problems'] == [] and not __import__('os').path.exists('$servers_dir/10002.owed')\""
shows 'dst=1.0.0.1 sport=[0-9]* dport=443' ip netns exec qexit conntrack -L -s 10.210.1.2 2>/dev/null &&
	fail "a connection to an address no longer listed goes on"
refused_now plugged 1.1.1.1 443 || fail "the set was not emptied"
asks plugged 10.210.0.1 more.test "NOERROR 1.1.1.1" || fail "more.test: $(ask_code plugged 10.210.0.1 more.test)"
connects plugged 1.1.1.1 443 || fail "a listed name's address after the narrower list"
pass "a wider list reloads the resolver and keeps the connections; a narrower one restarts it, empties its set and ends them"

# Back to "open": the resolver restarted without the set, the chain and set removed, the machine out again.
python3 "$work/db.py" "$db" 'c1=only.test'
wait_for "names_is \"s['reach'] == {'10.210.1.1': 'open', '10.210.1.2': 'open'} and s['problems'] == []\""
wait_for "asks plugged 10.210.0.1 unlisted.test 'NOERROR 1.1.1.1'"
wait_for "! ip netns exec qexit nft list chain inet qorpera_agent_exit only_10002 >/dev/null 2>&1"
ip netns exec qexit nft list set inet qorpera_agent_exit allow_10002 >/dev/null 2>&1 && fail "allow_10002 stayed"
asks plugged 10.210.0.1 only.test NXDOMAIN || fail "only.test is not blocked: $(ask_code plugged 10.210.0.1 only.test)"
connects plugged 1.0.0.1 443 || fail "an open company's machine cannot reach any address"
pass "back to open: the resolver asks for every name again, its chain and set go, and the machine reaches out"

# Fail closed: a company whose rules are not usable has no element, and its machines' DNS is dropped wherever it goes;
# with no element in reach either, they reach nothing outside.
refused=$(refused_dns)
python3 "$work/db.py" "$db" 'c1=bad'
wait_for "names_is \"s['resolvers'] == {'c0': 10001} and s['mapped'] == {'10.210.1.1': 10001}\""
dns_is "10.210.1.1:10001" || fail "the DNS map with c1's rules not usable: $(dns_map) / $(dns_allowed)"
for server in 10.210.0.1 8.8.8.8; do
	asks plugged "$server" open.test "no answer" || fail "c1's machine got DNS via $server: $(ask_code plugged "$server" open.test)"
done
(($(refused_dns) >= refused + 2)) || fail "refused_dns counted $refused, then $(refused_dns)"
asks agent 10.210.0.1 open.test "NOERROR 1.1.1.1" || fail "c0's machine lost DNS"
[[ $(reach_map) == "10.210.1.1:open" ]] || fail "the reach map with c1's rules not usable: $(reach_map)"
refused_now plugged 1.1.1.1 443 || fail "c1's machine reached a site with its rules not usable"
# A flow refused once is logged once an hour: 443 to 1.1.1.1 was refused before (not listed), port 80 never was.
refused_now plugged 1.1.1.1 80 || fail "c1's machine reached a site on port 80 with its rules not usable"
wait_for "grep -q '\"dport\":80,\"dst\":\"1.1.1.1\",\"event\":\"refused\".*\"rule\":\"rules_unknown\"' $log_file"
connects agent 1.1.1.1 443 || fail "c0's machine lost its way out"
if bash "$tool" verify 2>"$work/verify.err"; then fail "verify passed with a company's rules not usable"; fi
grep -q "names: c1: its rules are not as the rules reader writes them" "$work/verify.err" || fail "verify: $(cat "$work/verify.err")"
wait_for "test ! -e $work/units/10002.pid"
[[ -e $servers_dir/10002.servers ]] && fail "a stopped resolver's servers file stayed"
pass "a company whose rules are not usable: no element, its machines' DNS dropped (to the exit or elsewhere) and counted, their flows refused and logged as rules_unknown, its resolver stopped, verify fails"

# A company the rules file does not list yet: no element either.
python3 "$work/db.py" "$db" 'c1=null'
wait_for "names_is \"s['mapped'] == {'10.210.1.1': 10001, '10.210.1.2': 53} and s['problems'] == []\""
touch "$db.pause"
sleep 0.5
python3 - "$rules_file" <<'EOF'
import json, os, sys
value = json.load(open(sys.argv[1]))
del value["companies"]["c1"]
with open(sys.argv[1] + ".tmp", "w") as f:
    json.dump(value, f)
os.chmod(sys.argv[1] + ".tmp", 0o600)
os.replace(sys.argv[1] + ".tmp", sys.argv[1])
EOF
wait_for "names_is \"s['mapped'] == {'10.210.1.1': 10001}\""
dns_is "10.210.1.1:10001" || fail "the DNS map with c1 unknown: $(dns_map) / $(dns_allowed)"
asks plugged 10.210.0.1 open.test "no answer" || fail "c1's machine got DNS with its company unknown"
refused_now plugged 1.1.1.1 443 || fail "c1's machine reached a site with its company unknown"
rm "$db.pause"
wait_for "names_is \"s['mapped'] == {'10.210.1.1': 10001, '10.210.1.2': 53}\""
pass "a machine whose company the rules file does not list yet has no DNS and no way out"

# No rules file at all: every machine's DNS is dropped. A reader silent too long fails verify (its rules stay).
touch "$db.pause"
sleep 0.5
rm "$rules_file"
wait_for "names_is \"s['mapped'] == {}\""
dns_is "" || fail "the DNS map without a rules file: $(dns_map) / $(dns_allowed)"
asks agent 10.210.0.1 open.test "no answer" || fail "c0's machine got DNS without a rules file"
asks plugged 8.8.8.8 open.test "no answer" || fail "c1's machine got DNS without a rules file"
[[ $(reach_map) == "" ]] || fail "the reach map without a rules file: $(reach_map)"
refused_now agent 1.1.1.1 443 || fail "c0's machine reached a site without a rules file"
if bash "$tool" verify 2>"$work/verify.err"; then fail "verify passed without a rules file"; fi
grep -q "names: no rules file yet" "$work/verify.err" || fail "verify: $(cat "$work/verify.err")"
rm "$db.pause"
wait_for "names_is \"s['mapped'] == {'10.210.1.1': 10001, '10.210.1.2': 53} and s['problems'] == []\""
touch "$db.pause"
sleep 0.5
python3 -c 'import json, sys; json.dump({"schema": "qorpera.agent-exit-rules-status/v1", "checkedAt": "2000-01-01T00:00:00.000Z", "readAt": "2000-01-01T00:00:00.000Z", "ok": True, "problem": None, "companies": 2}, open(sys.argv[1], "w"))' \
	"$work/rules-status.json"
wait_for "names_is \"any(p.startswith('the rules reader silent for') for p in s['problems'])\""
asks agent 10.210.0.1 blocked.test NXDOMAIN || fail "a silent reader's last rules did not stay"
if bash "$tool" verify 2>"$work/verify.err"; then fail "verify passed with the rules reader silent"; fi
grep -q "names: the rules reader silent for" "$work/verify.err" || fail "verify: $(cat "$work/verify.err")"
rm "$db.pause"
wait_for "bash $tool verify >/dev/null 2>&1"
pass "without a rules file no machine has DNS or a way out; a rules reader silent for too long fails verify, its last rules stay"

# A resolver that dies is started again on its port.
resolver=$(resolver_pid 10001)
[[ -n $resolver ]] || fail "c0's resolver is not running"
kill "$resolver"
wait_for "[[ -n \$(resolver_pid 10001) && \$(resolver_pid 10001) != $resolver ]]"
wait_for "asks agent 10.210.0.1 blocked.test NXDOMAIN"
names_is "s['resolvers'] == {'c0': 10001} and s['mapped']['10.210.1.1'] == 10001" ||
	fail "after the resolver died: $(names_get s)"
resolver=$(resolver_pid 10001)
pass "a resolver that dies is started again, on the same port"

# Rules with an empty block list: a resolver of its own that blocks nothing.
python3 "$work/db.py" "$db" 'c1='
wait_for "names_is \"s['mapped'] == {'10.210.1.1': 10001, '10.210.1.2': 10002} and s['problems'] == []\""
[[ -e $servers_dir/10002.servers && ! -s $servers_dir/10002.servers ]] || fail "c1's servers file: $(ls -l "$servers_dir")"
asks plugged 10.210.0.1 only.test "NOERROR 1.1.1.1" || fail "an empty block list blocked: $(ask_code plugged 10.210.0.1 only.test)"
asks plugged 8.8.8.8 blocked.test "NOERROR 1.1.1.1" || fail "an empty block list: $(ask_code plugged 8.8.8.8 blocked.test)"
pass "rules that block nothing: every name resolves"

# The machine goes: the agent plug takes its element out (also while the names reconciler is down), and the names
# reconciler stops its company's resolver and gives the port back.
kill -STOP "$names_pid"
python3 "$work/fixture.py" "$work/lxd.json" "$AGENT"
wait_for "test ! -e $clients_dir/10.210.1.2.json"
dns_is "10.210.1.1:10001" || fail "a removed machine kept its DNS element: $(dns_map) / $(dns_allowed)"
kill -CONT "$names_pid"
wait_for "names_is \"s['resolvers'] == {'c0': 10001} and s['mapped'] == {'10.210.1.1': 10001} and s['problems'] == []\""
wait_for "test ! -e $work/units/10002.pid"
[[ -e $servers_dir/10002.servers ]] && fail "a stopped resolver's servers file stayed"
[[ $(cat "$QORPERA_AGENT_EXIT_STATE_DIR/names/ports.json") == '{"c0": 10001}' ]] ||
	fail "ports.json: $(cat "$QORPERA_AGENT_EXIT_STATE_DIR/names/ports.json")"
pass "a removed machine loses its DNS element with its entry; its company's resolver is stopped and its port given back"

[[ -e $QORPERA_AGENT_EXIT_STATE_DIR/quarantine/10.210.1.2 ]] || fail "no quarantine for a removed machine"
[[ -e $QORPERA_AGENT_EXIT_STATE_DIR/dhcp-hosts/10.210.1.2 ]] && fail "a removed machine's lease file stayed"
shows '"address":"10.210.1.2","company":"c1","event":"unplugged"' client_history || fail "no unplugged line: $(client_history)"
ip netns exec plugged busybox udhcpc -i eth0 -n -q -f -t 2 -T 1 -s /bin/true >/dev/null 2>&1 &&
	fail "the name service still gives a removed machine its address"
next=$(python3 "$plug_tool" plug --kind office --company c4 --machine o4 --project qp --instance vm4)
[[ $next == *'"10.210.1.25"'* ]] || fail "a plug during the quarantine: $next"
pass "a removed machine is quarantined first, then loses its lease (no more DHCP) and entry; its address is skipped"

python3 "$work/age.py" "$clients_dir" 10.210.1.1
wait_for "test \"\$(ls $clients_dir)\" = 10.210.1.1.json"
grep -q "the machine was never created" "$work/plug.out" || fail "plug: $(cat "$work/plug.out")"
[[ $(client_history | grep -c '"event":"unplugged"') == 2 ]] || fail "unplugged lines: $(client_history | grep -c '"event":"unplugged"')"
[[ $(client_history | grep -c '"event":"dropped"') == 22 ]] || fail "dropped lines: $(client_history | grep -c '"event":"dropped"')"
ip link del pv0
ip netns del plugged
pass "plugs whose machines never appear are given up after an hour, as dropped: never attributed"

# --- The logs on the node ------------------------------------------------------------------------------------------
logs_tool=$here/qorpera-agent-exit-logs.py
LOG=$QORPERA_AGENT_EXIT_LOG_DIR
today=$(date -u +%F)
bash "$tool" logs >"$work/logs.out" || fail "the logs' tender: $(cat "$work/logs.out")"
python3 "$logs_tool" count --log-dir "$LOG" --day "$today" >"$work/count.json" || fail "count: $(cat "$work/count.json")"
python3 - "$work/count.json" >"$work/countcheck.out" 2>&1 <<'EOF' || fail "counts: $(cat "$work/countcheck.out") $(cat "$work/count.json")"
import json, sys
c = json.load(open(sys.argv[1]))["companies"]
assert c["c0"]["connections"] > 0 and c["c0"]["machines"] == 1, c
assert c["c0"]["refusedByRule"].get("our_networks", 0) > 0, c
# The plugged machine's TCP to 8443, its ping and its UDP, under the company its plugged line names.
assert c["c1"]["connections"] >= 3 and set(c["c1"]["byProto"]) >= {"tcp", "udp", "icmp"}, c
# Its flows refused in "only listed" mode and with its rules not usable.
assert c["c1"]["refusedByRule"].get("not_listed", 0) > 0 and c["c1"]["refusedByRule"].get("rules_unknown", 0) > 0, c
EOF
pass "the counts tie each machine's connections and refusals to its company"
# Parts of one byte: today's open files are sealed, and dns.log is cut while dnsmasq writes on into it.
python3 "$logs_tool" tend --log-dir "$LOG" --status "$QORPERA_AGENT_EXIT_RUN_DIR/logs.json" --part-bytes 1 --settle 0.5 \
	>"$work/tend.out" || fail "tend: $(cat "$work/tend.out")"
[[ -e $LOG/flows-$today.p001.jsonl.gz && -e $LOG/clients-$today.p001.jsonl.gz ]] || fail "not sealed: $(ls "$LOG")"
[[ ! -s $LOG/dns.log ]] || fail "dns.log was not cut: $(wc -c <"$LOG/dns.log")"
shows 'query\[A\] example.test from 10.210.1.1' zcat "$LOG"/dns-*.log.gz || fail "the DNS part lacks the earlier queries"
[[ $(ip netns exec agent python3 "$work/ask.py" 10.210.0.1 rotated.test) == 1.1.1.1 ]] || fail "DNS after the cut"
wait_for "grep -q 'query\[A\] rotated.test from 10.210.1.1' $LOG/dns.log"
[[ $(head -c 1 "$LOG/dns.log" | od -An -tx1 | tr -d ' ') != 00 ]] || fail "dnsmasq wrote past a hole after the cut"
connects agent 1.1.1.1 443 || fail "the agent cannot connect after the cut"
wait_for "grep -q '\"event\":\"new\"' $LOG/flows-$today.jsonl"
python3 "$logs_tool" count --log-dir "$LOG" --day "$today" >"$work/count2.json" || fail "count: $(cat "$work/count2.json")"
python3 -c 'import json, sys; a, b = (json.load(open(f))["companies"]["c0"]["connections"] for f in sys.argv[1:]); assert b > a, (a, b)' \
	"$work/count.json" "$work/count2.json" || fail "the count after sealing lost lines"
pass "the tender seals open files into parts and cuts dns.log; the writers go on in new files, and counts read all"
# The parts go to the NAS under this node's name and their day, each read back; the lookup finds the agent's
# connection there and on the node, with its company, machine and the name it looked up.
host=$(python3 -c 'import socket; print(socket.gethostname())')
bash "$tool" ship >"$work/ship.out" || fail "ship: $(cat "$work/ship.out")"
for part in "flows-$today.p001.jsonl.gz" "clients-$today.p001.jsonl.gz" "$(cd "$LOG" && ls dns-*.log.gz | head -1)"; do
	cmp -s "$LOG/$part" "$work/nas/$host/$today/$part" || fail "$part is not on the NAS: $(ls -R "$work/nas")"
	[[ -e $LOG/shipped/$part.json ]] || fail "no shipped record for $part: $(ls "$LOG/shipped")"
done
bash "$tool" lookup --remote 1.1.1.1 --remote-port 443 --at "$(date +%s)" --json >"$work/lookup.json" ||
	fail "lookup: $(cat "$work/lookup.json")"
python3 - "$work/lookup.json" "$work/nas/$host/status.json" "$host" "$today" >"$work/lookupcheck.out" 2>&1 <<'EOF' || fail "lookup: $(cat "$work/lookupcheck.out") $(cat "$work/lookup.json")"
import json, sys
r, status = (json.load(open(path)) for path in sys.argv[1:3])
host, today = sys.argv[3:]
# Today's open connection log and dns.log since the cut are on the node only: the other nodes' lookups read that here.
assert status["host"] == host and today in status["notShipped"]["flows"] and today in status["notShipped"]["dns"], status
assert r["nodes"] == [host], r["nodes"]
found = [c for c in r["connections"] if c["src"] == "10.210.1.1"]
assert found and all((c["company"], c["machine"]) == ("c0", "m0") for c in found), found
assert any(c["name"] == "rotated.test" for c in found), found
EOF
bash "$tool" lookup --agent 10.210.1.1 --at "$(date +%s)" >"$work/lookup.out" || fail "lookup: $(cat "$work/lookup.out")"
grep -q "on $host: company c0, machine m0; 10.210.1.1:" "$work/lookup.out" || fail "lookup: $(cat "$work/lookup.out")"
# The logger's alive lines, which the lookup reads for the times it was not logging.
{ zcat "$LOG"/flows-*.jsonl.gz; cat "$LOG/flows-$today.jsonl"; } | grep '"event":"alive"' >/dev/null || fail "the logger wrote no alive line"
pass "the shipper copies the sealed parts to the NAS; the lookup names the company, machine and name behind a connection"
# A line the logger cannot write (here: a folder where its file goes) makes the exit unhealthy at once; once it can
# write again it says how many lines it lost, and the exit is healthy again.
for i in $(seq 1 20); do
	mv -f "$LOG/flows-$today.jsonl" "$work/flows-moved-$i" 2>/dev/null || true
	mkdir "$LOG/flows-$today.jsonl" 2>/dev/null && break
done
[[ -d $LOG/flows-$today.jsonl ]] || fail "could not put a folder where the connection log goes"
connects agent 1.1.1.1 443 || fail "the agent cannot connect"
for _ in $(seq 1 50); do [[ -e $QORPERA_AGENT_EXIT_RUN_DIR/logger.failing ]] && break; sleep 0.2; done
[[ -e $QORPERA_AGENT_EXIT_RUN_DIR/logger.failing ]] || fail "a line that could not be written left no mark: $(tail -3 "$work/log.out")"
bash "$tool" verify 2>"$work/verify-failing.err" && fail "verify passed while the connection log could not be written"
grep -q "cannot write the connection log: " "$work/verify-failing.err" || fail "verify: $(cat "$work/verify-failing.err")"
# Its gap line comes only once it writes again: until then the lookup learns it from the mark.
bash "$tool" lookup --remote 1.1.1.1 --at "$(date +%s)" --json >"$work/lookup-failing.json" || fail "lookup: $(cat "$work/lookup-failing.json")"
grep -q '"why": "the connection logger is failing now: cannot write the connection log: ' "$work/lookup-failing.json" ||
	fail "the lookup did not say the logger is failing: $(cat "$work/lookup-failing.json")"
rmdir "$LOG/flows-$today.jsonl"
for _ in $(seq 1 75); do [[ -e $QORPERA_AGENT_EXIT_RUN_DIR/logger.failing ]] || break; sleep 0.2; done
[[ ! -e $QORPERA_AGENT_EXIT_RUN_DIR/logger.failing ]] || fail "the logger did not recover once it could write"
grep -Eq '"reason":"[1-9][0-9]* lines could not be written \(' "$LOG/flows-$today.jsonl" ||
	fail "no gap line for the lines lost: $(grep gap "$LOG/flows-$today.jsonl" | tail -3)"
wait_for "bash $tool verify >/dev/null 2>&1"
pass "a line the logger cannot write makes the exit unhealthy at once; it recovers by itself and says what it lost"
# Past its cap the logger pauses: no connection lines, traffic goes on, the exit is unhealthy; it goes on once there is
# room, with a gap line that says how many lines it did not write.
kill "$logger_pid"
wait "$logger_pid" 2>/dev/null || true
size=$(python3 -c 'import os, sys; print(sum(e.stat().st_size for e in os.scandir(sys.argv[1]) if e.is_file(follow_symlinks=False)))' "$LOG")
QORPERA_AGENT_EXIT_LOG_CAP_BYTES=$((size + 2000000)) bash "$tool" log >>"$work/log.out" 2>&1 &
logger_pid=$!
pids+=($!)
wait_for "test \$(grep -c 'logger started' $LOG/flows-$today.jsonl) -ge 1"
wait_for "bash $tool verify >/dev/null 2>&1"
head -c 4000000 /dev/zero >"$LOG/filler"
for _ in $(seq 1 75); do [[ -e $QORPERA_AGENT_EXIT_RUN_DIR/logger.pause ]] && break; sleep 0.2; done
[[ -e $QORPERA_AGENT_EXIT_RUN_DIR/logger.pause ]] || fail "the logger did not pause past its cap: $(tail -3 "$work/log.out")"
bash "$tool" verify 2>"$work/verify-pause.err" && fail "verify passed while the connection log paused"
grep -q "connection log paused: " "$work/verify-pause.err" || fail "verify: $(cat "$work/verify-pause.err")"
bash "$tool" lookup --remote 1.1.1.1 --at "$(date +%s)" --json >"$work/lookup-pause.json" || fail "lookup: $(cat "$work/lookup-pause.json")"
grep -q '"why": "the connection log is paused now: the node' "$work/lookup-pause.json" ||
	fail "the lookup did not say the log is paused: $(cat "$work/lookup-pause.json")"
written=$(grep -c '"event":"new"' "$LOG/flows-$today.jsonl" || true)
connects agent 1.1.1.1 443 || fail "a machine's traffic stopped while the log paused"
sleep 1
[[ $(grep -c '"event":"new"' "$LOG/flows-$today.jsonl" || true) == "$written" ]] || fail "the paused logger wrote a connection line"
# DNS goes on answering, and its record is emptied while the log pauses.
[[ $(ip netns exec agent python3 "$work/ask.py" 10.210.0.1 paused.test) == 1.1.1.1 ]] || fail "DNS while the log pauses"
for _ in $(seq 1 75); do grep -Eq '"reason":"paused: [1-9][0-9]* bytes of the DNS record not kept"' "$LOG/flows-$today.jsonl" && break; sleep 0.2; done
grep -Eq '"reason":"paused: [1-9][0-9]* bytes of the DNS record not kept"' "$LOG/flows-$today.jsonl" ||
	fail "dns.log was not emptied while the log paused: $(wc -c <"$LOG/dns.log")"
rm "$LOG/filler"
for _ in $(seq 1 75); do [[ -e $QORPERA_AGENT_EXIT_RUN_DIR/logger.pause ]] || break; sleep 0.2; done
[[ ! -e $QORPERA_AGENT_EXIT_RUN_DIR/logger.pause ]] || fail "the logger did not go on with room again"
grep -q '"event":"gap".*"reason":"paused: ' "$LOG/flows-$today.jsonl" || fail "no gap line for the pause"
grep -Eq '"reason":"resumed: [1-9][0-9]* lines not written while paused"' "$LOG/flows-$today.jsonl" ||
	fail "no gap line saying what the pause missed: $(grep gap "$LOG/flows-$today.jsonl" | tail -3)"
wait_for "bash $tool verify >/dev/null 2>&1"
pass "past its cap the logger pauses (traffic goes on, the exit is unhealthy), then goes on and says what it missed"
kill "$logger_pid"
wait "$logger_pid" 2>/dev/null || true
bash "$tool" log >>"$work/log.out" 2>&1 &
logger_pid=$!
pids+=($!)
wait_for "bash $tool verify >/dev/null 2>&1"

# --- The brake (E7) -----------------------------------------------------------------------------------------------
# Company cB's machine, plugged in as in the plug's part above, goes past the founder's levels; the agent machine
# (company c0) does not.
cat >"$work/burst.py" <<'EOF'
import socket, sys, threading
# argv: host port count timeout; opens count connections at once and prints how many connected.
host, port, count, timeout = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])
connected = []
def one():
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        connected.append(1)
    except OSError:
        pass
    finally:
        s.close()
threads = [threading.Thread(target=one) for _ in range(count)]
for t in threads:
    t.start()
for t in threads:
    t.join()
print(len(connected))
EOF
brake=$QORPERA_AGENT_EXIT_RUN_DIR/brake.json
# A Python expression over the guard's status (s), printed as JSON, or tested.
brake_get() { python3 -c 'import json, sys; s = json.load(open(sys.argv[1])); print(json.dumps(eval(sys.argv[2])))' "$brake" "$1"; }
brake_is() { [[ $(brake_get "$1" 2>/dev/null) == true ]]; }
# A Python expression tested over what the exit's brake rules hold, read as the guard reads them (r: machines, share,
# and counters, the counts by number in the set named first).
rules_are() {
	local list=(ip netns exec qexit nft -j list)
	printf '{"map": %s, "chain": %s, "set": %s}' "$("${list[@]}" map inet qorpera_agent_exit braked)" \
		"$("${list[@]}" chain inet qorpera_agent_exit share)" "$("${list[@]}" set inet qorpera_agent_exit "$1")" |
		python3 "$here/qorpera-agent-exit-log.py" --parse-brake |
		python3 -c 'import json, sys; r = json.load(sys.stdin); sys.exit(0 if eval(sys.argv[1]) else 1)' "$2"
}
braked_plug=$(as_creator python3 "$plug_tool" plug --kind machine --company cB --machine mB --project qp --instance vmB)
[[ $braked_plug == '{"address": "10.210.1.26", "hwaddr": "0e:51:0a:d2:01:1a"}' ]] || fail "plug: $braked_plug"
ip netns add braked
ip -n braked link set lo up
ip link add bv0 type veth peer name eth0 netns braked
ip -n braked link set eth0 address 0e:51:0a:d2:01:1a
ip link set bv0 master qagent0 up
ip -n braked link set eth0 up
ip -n braked addr add 10.210.1.26/16 dev eth0
ip -n braked route add default via 10.210.0.1
python3 "$work/fixture.py" "$work/lxd.json" "$AGENT" "qp/vmB:Running:10.210.1.26:cB:mB::bv0"
wait_for "shows '\"address\":\"10.210.1.26\",\"company\":\"cB\",\"event\":\"plugged\"' client_history"
wait_for "connects braked 1.1.1.1 443"
# The founder's levels, in the node's settings: past 5 new connections in 10 seconds a company is braked for 5 minutes,
# with a share of 2 new connections per 10 seconds. The logger reads them when it starts.
printf '%s\n' QORPERA_AGENT_EXIT_BRAKE_NEW_10S=5 QORPERA_AGENT_EXIT_BRAKE_SLOW_10S=2 QORPERA_AGENT_EXIT_BRAKE_MINUTES=5 \
	>"$work/settings"
kill "$logger_pid"
wait "$logger_pid" 2>/dev/null || true
QORPERA_AGENT_EXIT_SETTINGS=$work/settings bash "$tool" log >>"$work/log.out" 2>&1 &
logger_pid=$!
pids+=($!)
wait_for "brake_is \"s['on'] and s['levels'] == {'new10s': 5, 'failed60s': 0, 'slow10s': 2, 'minutes': 5}\""
wait_for "rules_are dropped \"r['share'] == ['slow 2'] and r['machines'] == {}\""
bash "$tool" verify >/dev/null || fail "verify with the brake on: $(bash "$tool" verify 2>&1)"
pass "the founder's levels in the node's settings switch the brake on: its share rule is in the exit, nothing braked yet"

[[ $(ip netns exec braked python3 "$work/burst.py" 1.1.1.1 443 12 3) == 12 ]] || fail "a burst before the brake did not all get through"
wait_for "grep -q '\"company\":\"cB\",\"event\":\"braked\",\"reason\":\"[0-9]* new connections in 10 seconds (level 5)\"' $LOG/flows-$today.jsonl"
wait_for "brake_is \"[(b['company'], b['machines']) for b in s['braked']] == [('cB', 1)]\""
number=$(brake_get "s['braked'][0]['number']")
until_before=$(brake_get "s['braked'][0]['until']")
wait_for "rules_are dropped \"r['machines'] == {'10.210.1.26': $number}\""
pass "a company past a level is braked: a braked line, and its machine in the exit's braked map with its number"
# Its share: 2 of 10 new connections at once get through, the rest are dropped (and resent once, at 1 second, before
# they give up), each counted once. Another company's machine is not braked.
let_through=$(ip netns exec braked python3 "$work/burst.py" 1.1.1.1 443 10 2)
[[ $let_through == 2 ]] || fail "a braked company got $let_through of 10 new connections at once through, not its share of 2"
for _ in 1 2 3; do connects agent 1.1.1.1 443 || fail "another company's machine was braked"; done
rules_are dropped "r['counters'] == {'$number': 8}" ||
	fail "dropped: $(ip netns exec qexit nft list set inet qorpera_agent_exit dropped)"
[[ $(ip netns exec qexit nft -j list counter inet qorpera_agent_exit dropped_braked |
	python3 -c 'import json, sys; print([i["counter"]["packets"] for i in json.load(sys.stdin)["nftables"] if "counter" in i][0])') -gt 8 ]] ||
	fail "no resent first packet was dropped: $(ip netns exec qexit nft list counter inet qorpera_agent_exit dropped_braked)"
# A dropped connection whose machine goes on resending gets through once the share has room again: dropped once, and
# let through once on a resend, it is not counted as dropped.
[[ $(ip netns exec braked python3 "$work/burst.py" 1.1.1.1 443 1 20) == 1 ]] || fail "a resent connection never got through"
rules_are dropped "r['counters'] == {'$number': 9}" ||
	fail "dropped: $(ip netns exec qexit nft list set inet qorpera_agent_exit dropped)"
wait_for "rules_are resent \"r['counters'] == {'$number': 1}\""
# The dropped ones count as new connections: the brake is held longer.
wait_for "brake_is \"s['braked'][0]['dropped'] == 8 and s['braked'][0]['until'] > $until_before\""
bash "$tool" verify >/dev/null || fail "verify with a company braked: $(bash "$tool" verify 2>&1)"
bash "$tool" status >"$work/status.out"
grep -Eq '10\.210\.1\.26 [^,}]*: (0x)?[0-9a-f]+' "$work/status.out" ||
	fail "status does not show the braked machine: $(cat "$work/status.out")"
grep -q '"company": "cB"' "$work/status.out" || fail "status does not show the brake: $(cat "$work/status.out")"
pass "past its share a braked company's new connections are dropped, each once however often resent, and hold the brake"
pass "another company's machine is not braked; the exit stays healthy and status shows the brake"
# Unplugged, the machine's counts go with it and it leaves the braked map at once, also while the logger (and its
# guard) is down: the plug destroys its elements (one already gone is no error). Its company stays braked. Its tried
# flows time out on their own, long before its address is given out again.
ip netns exec qexit nft destroy element inet qorpera_agent_exit new_by_client '{ 10.210.9.9 }' ||
	fail "destroying an element that is not there is an error here"
kill "$logger_pid"
wait "$logger_pid" 2>/dev/null || true
python3 "$work/fixture.py" "$work/lxd.json" "$AGENT"
wait_for "shows '\"address\":\"10.210.1.26\",\"company\":\"cB\",\"event\":\"unplugged\"' client_history"
grep -q "cannot clear 10.210.1.26" "$work/plug.out" && fail "plug: $(grep "cannot clear" "$work/plug.out")"
new_left=$(ip netns exec qexit nft list set inet qorpera_agent_exit new_by_client)
grep -q '10\.210\.1\.26 ' <<<"$new_left" && fail "the unplugged machine's counts stayed: $new_left"
rules_are dropped "r['machines'] == {}" ||
	fail "an unplugged machine stayed braked: $(ip netns exec qexit nft list map inet qorpera_agent_exit braked)"
QORPERA_AGENT_EXIT_SETTINGS=$work/settings bash "$tool" log >>"$work/log.out" 2>&1 &
logger_pid=$!
pids+=($!)
wait_for "brake_is \"[(b['company'], b['machines']) for b in s['braked']] == [('cB', 0)]\""
sleep 3
rules_are dropped "r['machines'] == {}" || fail "the guard braked an unplugged machine again"
ip link del bv0
ip netns del braked
pass "an unplugged machine's counts go with it and it leaves the braked map at once, guard or not; its company stays braked"
# Without levels, a new logger ends the brake it kept (its status file) at once, and says what it dropped.
kill "$logger_pid"
wait "$logger_pid" 2>/dev/null || true
bash "$tool" log >>"$work/log.out" 2>&1 &
logger_pid=$!
pids+=($!)
wait_for "grep -q '\"company\":\"cB\",\"dropped\":8,\"event\":\"unbraked\"' $LOG/flows-$today.jsonl"
wait_for "rules_are dropped \"r['share'] == [] and r['machines'] == {}\""
wait_for "brake_is \"not s['on'] and s['braked'] == [] and s['problems'] == []\""
wait_for "bash $tool verify >/dev/null 2>&1"
pass "with its levels gone the logger ends the brake it kept at once, with an unbraked line that says what it dropped"
# A level that cannot be meant (a share as large as the level) leaves the brake off and the exit unhealthy.
kill "$logger_pid"
wait "$logger_pid" 2>/dev/null || true
rm "$brake"
QORPERA_AGENT_EXIT_BRAKE_NEW_10S=5 QORPERA_AGENT_EXIT_BRAKE_SLOW_10S=5 bash "$tool" log >>"$work/log.out" 2>&1 &
logger_pid=$!
pids+=($!)
wait_for "test -e $brake"
bash "$tool" verify 2>"$work/verify-brake.err" && fail "verify passed with a share as large as its level"
grep -q "the brake: QORPERA_AGENT_EXIT_BRAKE_SLOW_10S=5 is not under QORPERA_AGENT_EXIT_BRAKE_NEW_10S=5" \
	"$work/verify-brake.err" || fail "verify: $(cat "$work/verify-brake.err")"
rules_are dropped "r['share'] == []" || fail "the brake is on with a level that cannot be meant"
# A level that looks like an option is a bad level too, not an argument the logger cannot start with.
kill "$logger_pid"
wait "$logger_pid" 2>/dev/null || true
rm "$brake"
QORPERA_AGENT_EXIT_BRAKE_NEW_10S=5 QORPERA_AGENT_EXIT_BRAKE_MINUTES=--5 bash "$tool" log >>"$work/log.out" 2>&1 &
logger_pid=$!
pids+=($!)
wait_for "test -e $brake"
bash "$tool" verify 2>"$work/verify-brake.err" && fail "verify passed with a level that looks like an option"
grep -q "the brake: QORPERA_AGENT_EXIT_BRAKE_MINUTES='--5' is not a whole number from 1 to 1440" \
	"$work/verify-brake.err" || fail "verify: $(cat "$work/verify-brake.err")"
rules_are dropped "r['share'] == []" || fail "the brake is on with a level that looks like an option"
kill "$logger_pid"
wait "$logger_pid" 2>/dev/null || true
bash "$tool" log >>"$work/log.out" 2>&1 &
pids+=($!)
wait_for "bash $tool verify >/dev/null 2>&1"
pass "a level that cannot be meant leaves the brake off and the exit unhealthy until it is fixed"

# --- An interrupted rebuild -------------------------------------------------------------------------------------
# The exit's namespace is replaced while its name service and logger still run in the old one, as after an up that
# rebuilt the links and stopped before it restarted them. The logger notices by itself; verify fails until the name
# service follows (its unit's restart, or the next up, moves it). A company's resolver left there is restarted by the
# names reconciler once it has not answered for its grace.
dns_pid=$(pgrep -f -- '--dhcp-range=')
resolver=$(resolver_pid 10001)
ip netns del qexit
bash "$tool" up >/dev/null
dns_is "10.210.1.1:10001" || fail "up did not fill the DNS map: $(dns_map) / $(dns_allowed)"
[[ $(reach_map) == "10.210.1.1:open" ]] || fail "up did not fill the reach map: $(reach_map)"
for _ in $(seq 1 150); do grep -q "watches an old namespace" "$work/log.out" && break; sleep 0.2; done
grep -q "watches an old namespace" "$work/log.out" || fail "the logger kept watching the old namespace: $(tail -3 "$work/log.out")"
bash "$tool" verify 2>"$work/verify3.err" && fail "verify passed with the name service in the old namespace"
grep -q "no DNS on 10.210.0.1:53" "$work/verify3.err" || fail "verify: $(cat "$work/verify3.err")"
kill "$dns_pid"
bash "$tool" dns >"$work/dns3.out" 2>&1 &
pids+=($!)
bash "$tool" log >"$work/log3.out" 2>&1 &
pids+=($!)
wait_for "shows '10.210.0.1:53 ' ip netns exec qexit ss -lnu"
for _ in $(seq 1 100); do [[ -n $(resolver_pid 10001) && $(resolver_pid 10001) != "$resolver" ]] && break; sleep 0.2; done
[[ -n $(resolver_pid 10001) && $(resolver_pid 10001) != "$resolver" ]] ||
	fail "c0's resolver stayed in the old namespace: $(tail -3 "$work/names.out")"
grep -q "problem: the resolver of c0 (port 10001) is not answering" "$work/names.out" || fail "names: $(tail -3 "$work/names.out")"
wait_for "bash $tool verify >/dev/null 2>&1"
# The new br0 has a new MAC; the machine has the gateway's as a static neighbour (above), so it takes the new one.
exit_mac=$(ip -n qexit -br link show br0 | awk '{print $3}')
ip -n agent neigh replace 10.210.0.1 lladdr "$exit_mac" dev eth0 nud permanent
asks agent 10.210.0.1 blocked.test NXDOMAIN ||
	fail "c0's machine after the rebuild: $(ask_code agent 10.210.0.1 blocked.test)"
connects agent 1.1.1.1 443 || fail "the agent machine has no way out after the rebuild"
pass "after an interrupted rebuild the logger leaves the old namespace by itself, verify fails until DNS follows, and a company's resolver left there is restarted into the new one; up filled reach and the machine goes out"

# --- Fail closed -------------------------------------------------------------------------------------------------
if bash "$tool" down 2>"$work/down.err"; then fail "down went ahead with a machine plugged in"; fi
grep -q "running or asleep (client map: 10.210.1.1 " "$work/down.err" || fail "down: $(cat "$work/down.err")"
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
echo '[]' >"$work/lxd.json"
wait_for "test -z \"\$(ls $clients_dir)\""
# A machine asleep has no port on the bridge; its client map entry still keeps the exit up.
python3 "$plug_tool" plug --kind machine --company c5 --machine m5 --project qp --instance asleep >/dev/null
if bash "$tool" down 2>"$work/down2.err"; then fail "down went ahead with a machine in the client map"; fi
grep -q "running or asleep (client map: 10.210.1.27 " "$work/down2.err" || fail "down: $(cat "$work/down2.err")"
pass "down refuses while the client map has a machine, also one asleep with no port"
python3 "$work/age.py" "$clients_dir"
wait_for "test -z \"\$(ls $clients_dir)\""
bash "$tool" dns >"$work/dns2.out" 2>&1 &
pids+=($!)
bash "$tool" log >"$work/log2.out" 2>&1 &
pids+=($!)
wait_for "shows '10.210.0.1:53 ' ip netns exec qexit ss -lnu"
bash "$tool" down >/dev/null || fail "down with nothing plugged in"
for part in qagent0 qx-br qx-up; do ip link show "$part" >/dev/null 2>&1 && fail "down left $part"; done
[[ -e /run/netns/qexit ]] && fail "down left the namespace"
nft list table inet qorpera_agent_exit_host >/dev/null 2>&1 && fail "down left the node's rules"
nft list table bridge qorpera_agent_exit_bridge >/dev/null 2>&1 && fail "down left the bridge rules"
pass "with nothing plugged in, down removes everything, with its name and log services running"
echo "ALL PASSED"
