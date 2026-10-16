#!/usr/bin/env bash
# Each company's names (E8b-2) and where its machines may go (E8c-1) on real systemd and a real LXD, inside the
# throwaway VM test/prove-names-vm.sh makes (never on a node, never on a shared test machine: it loads br_netfilter,
# installs the exit's units, a group and a user, and changes this kernel's tables). Run it only through that script:
#
#   node scripts/run-on-node.mjs --machine node01 --sudo --no-status -- \
#     bash deploy/agent-exit/test/prove-names-vm.sh </dev/null
#
# It installs the exit with install-agent-exit.sh and switches it on with ROLLOUT.md's step 1 as written (the NAS is a
# tmpfs here), stands in for the rules reader (a script that writes rules.json and its status as the reader does, from
# a small database file; the reader's own unit is never started), plugs real LXD containers of two companies in as a
# creator does, and asks names from inside them, of the exit and of a stand-in internet's DNS servers (9.9.9.9 and
# 1.1.1.1, which log every name they are asked). It checks what the Docker proof cannot:
# - before the reader runs, verify names exactly the two problems step 1 says;
# - a company that gets rules gets a resolver of its own: dnsmasq under its template unit (not enabled) in the exit's
#   namespace, its servers file 0644 with exactly its blocked names; the exit's DNS map sends its machines' DNS there,
#   to any address: a blocked name, the names under it and the names under a `*.` name are "no such name" (also
#   through the machine's own resolver) and never reach the upstreams; every other name resolves and serves;
# - a company without rules keeps the main dnsmasq, and no machine reaches another company's port;
# - a new rules version applies within seconds by a reload of the same dnsmasq; a company's move to its own resolver
#   ends its machines' open DNS flows; ROLLOUT.md's step 9 on a running exit keeps the resolvers; a killed resolver
#   comes back;
# - "only listed" (E8c-1): a company's switch restarts its resolver and ends its machines' connections; the unit's own
#   dnsmasq (in its sandbox, as nobody) puts each address it gives out in the company's set, and its machines reach TCP
#   443 on those only; the exit's reload empties the set and the reconciler reloads the resolver; a narrower list
#   restarts it again; back to open, the company's chain and set go;
# - the exit fails closed: rules that cannot be used, or no rules file, leave the machines no DNS and no way out, and
#   verify says why;
# - a company whose last machine goes gives its resolver and its port back; the exit's stop (step 1's undo) stops every
#   resolver and leaves nothing behind;
# - with QORPERA_AGENT_EXIT_PROOF_PREVIOUS (a previous release's deploy/agent-exit folder): on an exit that release
#   switched on, step 9 and its undo (a release before E8b-2), or step 10 and its undo (a release with E8b-2: an "only
#   listed" company's resolver restarts and its machine's connection ends).
# The plug and the names reconciler run at their own intervals (5 and 2 seconds). Prints PASS lines, then ALL PASSED.
set -euo pipefail

here=${QORPERA_AGENT_EXIT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
package=${QORPERA_AGENT_EXIT_RULES_PACKAGE:?the rules reader package folder}
previous=${QORPERA_AGENT_EXIT_PROOF_PREVIOUS:-}
IMAGE=${QORPERA_AGENT_EXIT_PROOF_IMAGE:?the container image}
PROJECT=qae8n
POOL=qae8n
C1=0f6c2b1e-4d3a-4b5c-8e9f-0123456789ab
C2=7d1e5a90-2b4c-4f8e-9a6d-3c5b7e9f1a2d
X=/usr/local/libexec/qorpera-agent-exit/qorpera-agent-exit.sh
PLUG=/usr/local/libexec/qorpera-agent-exit/qorpera-agent-plug.py
RUN=/run/qorpera-agent-exit
STATE=/var/lib/qorpera-agent-exit
LOGS=/var/log/qorpera-agent-exit
NAS=/srv/qorpera/agent-exit-logs
READER_STATUS=/run/qorpera-agent-exit-rules/status.json
NOT_HEALTHY="qorpera-agent-exit: not healthy:"
NO_RULES_FILE="$NOT_HEALTHY names: no rules file yet: every machine's DNS is dropped until the rules reader writes it"

fail() {
	echo "FAIL: $*" >&2
	diagnose >&2 || true
	exit 1
}
pass() { echo "PASS: $*"; }
within() {
	local deadline=$((SECONDS + $1))
	until eval "$2"; do
		((SECONDS < deadline)) || fail "not within $1 s: $2"
		sleep 0.2
	done
}
# Whether a command's output has a line that matches: `shows PATTERN COMMAND...` (PATTERN as grep's basic one). The
# output is read whole first: piped into `grep -q`, a command still writing after the first match dies of SIGPIPE, and
# pipefail fails the check although the line is there.
shows() {
	local out
	out=$("${@:2}") && grep -q -- "$1" <<<"$out"
}
lx() { lxc --project "$PROJECT" "$@" </dev/null; }
in_m() {
	local m=$1
	shift
	lxc --project "$PROJECT" exec "$m" -- "$@" </dev/null
}
lease_of() { in_m "$1" ip -4 -o addr show dev eth0 2>/dev/null | awk '{print $4}' | cut -d/ -f1; }
# One A question from a machine, past its systemd-resolved (which caches): `ask MACHINE SERVER NAME [PORT [FROM_PORT]]`
# prints "NXDOMAIN", "NOERROR <address>", "no answer", ...
ask() { in_m "$1" python3 /root/rcode.py "${@:2}" 2>&1; }
says() { [[ $(ask "$1" "$2" "$3" "${@:5}") == "$4" ]]; }
expect() {
	local got
	got=$(ask "$1" "$2" "$3" "${@:5}") || true
	[[ $got == "$4" ]] || fail "$1 asked $2${5:+ (port $5${6:+, from port $6})} for $3: \"$got\", not \"$4\""
}
json_is() {
	python3 -c 'import calendar, json, sys, time; s = json.load(open(sys.argv[1])); sys.exit(0 if eval(sys.argv[2]) else 1)' \
		"$1" "$2" 2>/dev/null
}
names_is() { json_is "$RUN/names.json" "$1"; }
names_get() { python3 -c 'import json, sys; s = json.load(open(sys.argv[1])); print(json.dumps(eval(sys.argv[2])))' "$RUN/names.json" "$1"; }
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
# The exit's DNS map and its allowed set both hold exactly these "address:port" pairs.
dns_is() { [[ $(dns_map) == "$1" && $(dns_allowed) == "$1" ]]; }
pairs() { printf '%s\n' "$@" | LC_ALL=C sort | paste -sd' ' -; }
# The map reach as "address:chain" pairs (E8c-1), and a set's addresses.
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
set_addresses() {
	local text
	text=$(ip netns exec qexit nft -j list set inet qorpera_agent_exit "$1") || return 1
	python3 -c '
import json, sys
found = []
for item in json.loads(sys.argv[1])["nftables"]:
    found += [elem for elem in (item.get("set") or {}).get("elem", []) or [] if isinstance(elem, str)]
print(" ".join(sorted(found)))' "$text"
}
# A machine's TCP connection to an address and port: "open", "refused" (at once: a reset or an ICMP error) or
# "timeout". `expect_tcp MACHINE ADDRESS PORT WANTED`.
tcp_to() {
	in_m "$1" python3 -c '
import socket, sys
try:
    socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=3).close()
    print("open")
except socket.timeout:
    print("timeout")
except OSError:
    print("refused")' "$2" "$3" 2>&1
}
expect_tcp() {
	local got
	got=$(tcp_to "$1" "$2" "$3") || true
	[[ $got == "$4" ]] || fail "$1 to $2:$3: \"$got\", not \"$4\""
}
refused_dns() {
	local text
	text=$(ip netns exec qexit nft list counter inet qorpera_agent_exit refused_dns)
	grep -o 'packets [0-9]*' <<<"$text" | cut -d' ' -f2
}
# verify's problem lines (stderr), sorted; nothing when healthy.
verify_problems() {
	local out
	out=$("$X" verify 2>&1 >/dev/null) || true
	[[ -z $out ]] || LC_ALL=C sort <<<"$out"
}
verify_says() {
	local out
	out=$(verify_problems)
	grep -qxF -- "$1" <<<"$out"
}
healthy() { "$X" verify >/dev/null 2>&1; }
resolver() { echo "qorpera-agent-exit-resolver@$1.service"; }
unit_state() { systemctl is-active "$(resolver "$1")" 2>/dev/null || true; }
main_pid() { systemctl show -p MainPID --value "$(resolver "$1")"; }
restarts() { systemctl show -p NRestarts --value "$(resolver "$1")"; }
active_resolvers() {
	systemctl list-units --state=active --plain --no-legend --full 'qorpera-agent-exit-resolver@*.service' 2>/dev/null || true
}
dns_log_has() {
	local log
	log=$(cat "$LOGS/dns.log" 2>/dev/null) || return 1
	grep -qiE -- "$1" <<<"$log"
}
diagnose() {
	local journal
	echo "--- verify"
	"$X" verify 2>&1 || true
	echo "--- names.json"
	cat "$RUN/names.json" 2>&1 || true
	echo "--- plug.json"
	cat "$RUN/plug.json" 2>&1 || true
	echo "--- names/"
	ls -l "$RUN/names" 2>&1 || true
	echo "--- the reach map and the only-listed chains and sets"
	ip netns exec qexit nft list map inet qorpera_agent_exit reach 2>&1 || true
	ip netns exec qexit nft list ruleset 2>&1 | grep -A 4 -E '(chain only|set allow)_' || true
	echo "--- units"
	systemctl list-units --all --plain --no-legend --full 'qorpera-agent-*' 2>&1 || true
	journalctl --sync 2>/dev/null || true
	journal=$(journalctl -u qorpera-agent-exit-names.service --no-pager -o cat -n 30 2>&1 || true)
	echo "--- the names unit"
	echo "$journal"
	journal=$(journalctl -u 'qorpera-agent-exit-resolver@*.service' --no-pager -n 30 2>&1 || true)
	echo "--- the resolvers"
	echo "$journal"
	echo "--- dns.log"
	tail -n 30 "$LOGS/dns.log" 2>&1 || true
	echo "--- upstream.log"
	tail -n 20 "${work:-/nonexistent}/upstream.log" 2>&1 || true
}

[[ $(id -u) -eq 0 ]] || fail "run as root"
[[ -e /etc/qorpera-throwaway-vm ]] || fail "this proof runs only inside the throwaway VM of test/prove-names-vm.sh"
for part in /usr/local/libexec/qorpera-agent-exit "$STATE" "$RUN" /etc/systemd/system/qorpera-agent-exit.service \
	/etc/systemd/system/qorpera-agent-exit-names.service /run/netns/qexit /sys/class/net/qagent0; do
	[[ ! -e $part ]] || fail "$part exists"
done
for tool in setpriv useradd nft lxc dnsmasq conntrack python3; do command -v "$tool" >/dev/null || fail "missing $tool"; done

work=$(mktemp -d)
chmod 0755 "$work"
db=$work/db.json
pids=()
reader_pid=
cleanup() {
	set +e
	for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null; done
	for m in $(lxc --project "$PROJECT" list -c n -f csv 2>/dev/null </dev/null); do lx delete --force "$m" >/dev/null 2>&1; done
	umount "$NAS" 2>/dev/null
}
trap cleanup EXIT

# --- This VM as a node, with a stand-in internet ------------------------------------------------------------------
modprobe br_netfilter
sysctl -qw net.bridge.bridge-nf-call-iptables=1
ip netns add inet
ip -n inet link set lo up
ip link add vinet0 type veth peer name eth0 netns inet
ip addr add 198.51.100.254/24 dev vinet0
ip link set vinet0 up
ip -n inet addr add 198.51.100.1/24 dev eth0
ip -n inet addr add 198.51.100.2/24 dev eth0
ip -n inet link set eth0 up
ip -n inet route add default via 198.51.100.254
# The exit's upstreams, in the stand-in internet.
ip -n inet addr add 9.9.9.9/32 dev lo
ip -n inet addr add 1.1.1.1/32 dev lo
for upstream in 9.9.9.9 1.1.1.1; do ip route add "$upstream/32" via 198.51.100.1; done
cat >"$work/serve.py" <<'EOF'
import socket, threading
# A web server on 198.51.100.1:80 and :443 (plain HTTP on both) and 198.51.100.2:443: reads the request, answers "ok",
# closes. Each connection has a thread of its own, so one that sends nothing is held open.
def serve(c):
    try:
        c.recv(65536)
        c.sendall(b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok")
    except OSError:
        pass
    c.close()
def listen(s):
    while True:
        threading.Thread(target=serve, args=(s.accept()[0],), daemon=True).start()
bound = []
for where in [("198.51.100.1", 80), ("198.51.100.1", 443), ("198.51.100.2", 443)]:
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(where)
    s.listen(64)
    bound.append(s)
for s in bound:
    threading.Thread(target=listen, args=(s,), daemon=True).start()
print("ready", flush=True)
threading.Event().wait()
EOF
cat >"$work/upstream.py" <<'EOF'
import socket, struct, sys, threading
# The upstreams argv[1] (comma separated), on UDP and TCP port 53: every A question is answered 198.51.100.1 (one for a
# name starting "two." 198.51.100.2), every other with no address. Each question asked is logged to argv[2] as "name type" (in the case it was asked in).
log = open(sys.argv[2], "a", buffering=1)
lock = threading.Lock()
def answer(q):
    tid = struct.unpack(">H", q[:2])[0]
    i, labels = 12, []
    while q[i]:
        labels.append(q[i + 1:i + 1 + q[i]].decode())
        i += 1 + q[i]
    qtype = struct.unpack(">H", q[i + 1:i + 3])[0]
    with lock:
        log.write(f"{'.'.join(labels)} {qtype}\n")
    an = b""
    if qtype == 1:
        address = "198.51.100.2" if labels[0] == "two" else "198.51.100.1"
        an = b"\xc0\x0c" + struct.pack(">HHIH", 1, 1, 60, 4) + socket.inet_aton(address)
    return struct.pack(">HHHHHH", tid, 0x8180, 1, 1 if an else 0, 0, 0) + q[12:i + 5] + an
def udp(s):
    while True:
        q, peer = s.recvfrom(4096)
        try:
            s.sendto(answer(q), peer)
        except Exception:
            pass
def tcp(s):
    while True:
        c, _ = s.accept()
        try:
            n = struct.unpack(">H", c.recv(2))[0]
            q = b""
            while len(q) < n:
                q += c.recv(n - len(q))
            a = answer(q)
            c.sendall(struct.pack(">H", len(a)) + a)
        except Exception:
            pass
        c.close()
# Every socket is bound before any thread starts: a failed bind ends the script before it says ready.
bound = []
for address in sys.argv[1].split(","):
    u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    u.bind((address, 53))
    t = socket.socket()
    t.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    t.bind((address, 53))
    t.listen(64)
    bound += [(udp, u), (tcp, t)]
for serve, s in bound:
    threading.Thread(target=serve, args=(s,), daemon=True).start()
print("ready", flush=True)
threading.Event().wait()
EOF
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
# rules), company=bad (rules not as the reader writes them), company=a,b (open, these names blocked, none if empty),
# company=only:a,b (only listed: listed.example.com allowed, these blocked) or company=only:a,b+c,d (c and d allowed).
# Each change is a new version.
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
                       "allow": (allowed.split(",") if allowed else ["listed.example.com"]) if mode == "only-listed" else []}
with open(path + ".tmp", "w") as f:
    json.dump(db, f)
os.replace(path + ".tmp", path)
EOF
rules() { python3 "$work/db.py" "$db" "$@"; }
ip netns exec inet python3 "$work/serve.py" >"$work/serve.out" 2>&1 &
pids+=($!)
ip netns exec inet python3 "$work/upstream.py" 9.9.9.9,1.1.1.1 "$work/upstream.log" >"$work/upstream.out" 2>&1 &
pids+=($!)
within 30 "grep -q ready $work/serve.out && grep -q ready $work/upstream.out"
pass "this VM is a node, with a stand-in internet: a web server on 198.51.100.1 and the upstreams 9.9.9.9 and 1.1.1.1"

# --- The NAS and the installer ------------------------------------------------------------------------------------
# The NAS is a tmpfs on the mount point; then ROLLOUT.md step 1's NAS block from `findmnt` on, as written.
mkdir -p "$NAS"
mount -t tmpfs -o size=64m,mode=0755 qorpera-test-nas "$NAS"
{
	findmnt /srv/qorpera/agent-exit-logs
	# The share's marker (the shipper writes only into a mount point that holds it); there already on the second node.
	# Only on the mounted share: a mount that failed leaves the bare folder, which must never get one.
	mountpoint -q /srv/qorpera/agent-exit-logs &&
		{ test -e /srv/qorpera/agent-exit-logs/.qorpera-agent-exit-logs || touch /srv/qorpera/agent-exit-logs/.qorpera-agent-exit-logs; }
	grep -q '^QORPERA_AGENT_EXIT_NAS_DIR=' /etc/default/qorpera-agent-exit 2>/dev/null ||
		echo 'QORPERA_AGENT_EXIT_NAS_DIR=/srv/qorpera/agent-exit-logs' >>/etc/default/qorpera-agent-exit
} >"$work/nas.out" 2>&1 || fail "the NAS block: $(cat "$work/nas.out")"
[[ -e $NAS/.qorpera-agent-exit-logs ]] || fail "the NAS block left no marker"
getent group qorpera-agent-plug >/dev/null || groupadd --system qorpera-agent-plug
bash "$here/install-agent-exit.sh" "$package" >"$work/install.out" 2>&1 || fail "install: $(cat "$work/install.out")"
grep -q '^Installed\. Nothing is started or enabled' "$work/install.out" || fail "install: $(cat "$work/install.out")"
useradd --system --no-create-home --shell /usr/sbin/nologin --groups qorpera-agent-plug qcreator
as_creator() { setpriv --reuid=qcreator --regid=qcreator --init-groups -- sh -c 'umask 077; exec "$@"' sh "$@"; }
pass "the NAS block of ROLLOUT.md step 1 on a tmpfs share, and install-agent-exit.sh, which starts nothing"

# --- ROLLOUT.md step 1, before the rules reader runs ----------------------------------------------------------------
{
	systemctl enable --now qorpera-agent-exit.service qorpera-agent-exit-dns.service qorpera-agent-exit-log.service \
		qorpera-agent-plug.service qorpera-agent-exit-names.service qorpera-agent-exit-health.timer \
		qorpera-agent-exit-logs.timer qorpera-agent-exit-ship.timer &&
		systemctl start qorpera-agent-exit-logs.service qorpera-agent-exit-ship.service
} >"$work/step1.out" 2>&1 || fail "step 1: $(cat "$work/step1.out")"
two=$(printf '%s\n' "$NOT_HEALTHY names: the rules reader is not running (no status)" "$NO_RULES_FILE" | LC_ALL=C sort)
step1_checked() {
	[[ $(verify_problems) == "$two" ]] &&
		json_is "$RUN/logs.json" "s['problems'] == [] and s['capBytes'] == 2147483648 and 'freePercent' in s" &&
		json_is "$RUN/ship.json" "s['problems'] == [] and s['errors'] == []" &&
		json_is "$NAS/$(hostname)/status.json" "s['host'] == '$(hostname)' and s.get('through') is not None" &&
		json_is "$RUN/health.json" \
			"time.time() - calendar.timegm(time.strptime(s['checkedAt'], '%Y-%m-%dT%H:%M:%SZ')) < 20" &&
		shows 'br0 .*10\.210\.0\.1/16' "$X" status && shows 'up0 .*10\.209\.255\.2/30' "$X" status
}
within 30 step1_checked
pass "ROLLOUT.md step 1 as written: verify names exactly the two problems step 1 says (no reader status, no rules file); logs, ship, the NAS, health and status as step 1 checks them"

# --- The rules reader's stand-in ------------------------------------------------------------------------------------
install -d -m 0700 "$STATE/rules"
install -d -m 0755 /run/qorpera-agent-exit-rules
echo '{}' >"$db"
# Only once the exit's `up` made the client map: the stand-in lists it from its first pass.
start_reader() {
	within 30 "[[ -d $STATE/clients ]]"
	rm -f "$work/reader.out"
	python3 "$work/rules-reader.py" "$STATE/clients" "$STATE/rules/rules.json" "$db" "$READER_STATUS" \
		>"$work/reader.out" 2>&1 &
	reader_pid=$!
	pids+=("$reader_pid")
	within 30 "grep -q ready $work/reader.out"
}
start_reader
within 30 healthy
pass "with the rules reader's stand-in writing rules.json and its status, the exit is healthy (the reader's own unit never started)"

# --- Two companies' machines, plugged in as a creator does ------------------------------------------------------------
lxc storage create "$POOL" dir </dev/null >/dev/null
lxc project create "$PROJECT" -c features.images=false -c features.profiles=false </dev/null >/dev/null
# The creators' way: the creator plugs right before the create, then the card the plug gave goes on the machine.
machine() {
	local name=$1 company=$2 answer address hwaddr
	answer=$(as_creator python3 "$PLUG" plug --kind machine --company "$company" --machine "$name" --project "$PROJECT" \
		--instance "$name") || return 1
	address=$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["address"])' "$answer") || return 1
	hwaddr=$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["hwaddr"])' "$answer") || return 1
	lx init "$IMAGE" "$name" --no-profiles --storage "$POOL" -c limits.cpu=1 -c limits.memory=512MiB \
		-c user.qorpera.company_id="$company" -c user.qorpera.machine_id="$name" >/dev/null 2>&1 || return 1
	lx config device add "$name" eth0 nic nictype=bridged parent=qagent0 name=eth0 hwaddr="$hwaddr" \
		ipv6.address=none security.mac_filtering=true security.ipv6_filtering=true \
		security.port_isolation=true >/dev/null || return 1
	lx start "$name" || return 1
	echo "$address"
}
a1=$(machine m1 "$C1") || fail "cannot plug in and start m1"
a2=$(machine m2 "$C2") || fail "cannot plug in and start m2"
# 900 steps of 0.2 seconds: a container's first boot.
within 180 '[[ $(lease_of m1) == "$a1" && $(lease_of m2) == "$a2" ]]'
within 30 "names_is \"s['mapped'] == {'$a1': 53, '$a2': 53} and s['problems'] == []\""
for m in m1 m2; do lx file push "$work/rcode.py" "$m/root/rcode.py" >/dev/null; done
expect m1 10.210.0.1 open.example.com "NOERROR 198.51.100.1"
pass "m1 ($C1) at $a1 and m2 ($C2) at $a2, plugged in by a creator; without rules both have the main dnsmasq"

# --- C1 gets rules: its own resolver ------------------------------------------------------------------------------
rules "$C1=blocked.example.com,*.wild.example.com"
c1_rules() {
	names_is "s['resolvers'] == {'$C1': 10001} and s['mapped'] == {'$a1': 10001, '$a2': 53} and s['problems'] == []" &&
		dns_is "$(pairs "$a1:10001" "$a2:53")"
}
within 30 c1_rules
[[ $(unit_state 10001) == active ]] || fail "$(resolver 10001) is $(unit_state 10001)"
enabled=$(systemctl is-enabled "$(resolver 10001)" 2>&1 || true)
[[ $enabled != enabled ]] || fail "$(resolver 10001) is enabled"
r1=$(main_pid 10001)
[[ $(stat -L -c %i "/proc/$r1/ns/net") == "$(stat -L -c %i /run/netns/qexit)" ]] ||
	fail "the resolver (pid $r1) is not in the exit's namespace"
[[ $(cat "/proc/$r1/comm") == dnsmasq ]] || fail "the resolver's main process is $(cat "/proc/$r1/comm")"
[[ $(stat -c %a "$RUN/names/10001.servers") == 644 ]] || fail "10001.servers is $(stat -c %a "$RUN/names/10001.servers")"
cmp -s "$RUN/names/10001.servers" <(printf 'server=/*.wild.example.com/\nserver=/blocked.example.com/\n') ||
	fail "10001.servers holds: $(cat "$RUN/names/10001.servers")"
pass "$C1's rules give it a resolver on port 10001 within 30 s: dnsmasq (pid $r1) in the exit's namespace under $(resolver 10001) ($enabled), its servers file 0644 with exactly its two blocked names, and the DNS map sends m1 there"

# --- m1's names -------------------------------------------------------------------------------------------------
for server in 10.210.0.1 9.9.9.9; do
	for name in blocked.example.com sub.blocked.example.com a.wild.example.com; do expect m1 "$server" "$name" NXDOMAIN; done
	for name in open.example.com wild.example.com; do expect m1 "$server" "$name" "NOERROR 198.51.100.1"; done
done
if in_m m1 getent hosts blocked.example.com >/dev/null 2>&1; then fail "m1's own resolver found blocked.example.com"; fi
within 30 'in_m m1 getent hosts open.example.com >/dev/null 2>&1'
page=$(in_m m1 python3 -c 'import urllib.request; print(urllib.request.urlopen("http://open.example.com/", timeout=5).read().decode())' 2>&1) ||
	true
[[ $page == ok ]] || fail "m1 fetched http://open.example.com/: $page"
upstream=$(cat "$work/upstream.log")
! grep -iqE '^((sub\.)?blocked|a\.wild)\.example\.com ' <<<"$upstream" ||
	fail "a blocked name reached the upstreams: $(grep -iE 'blocked|a\.wild' <<<"$upstream")"
grep -iqE '^open\.example\.com ' <<<"$upstream" || fail "open.example.com never reached the upstreams"
pass "m1, to the exit and to 9.9.9.9 alike: blocked.example.com, the names under it and those under *.wild.example.com are NXDOMAIN, open.example.com and wild.example.com resolve; through m1's own resolver blocked.example.com is not found and http://open.example.com/ serves; no blocked name reached the upstreams"

# --- m2 keeps the main dnsmasq, never C1's ------------------------------------------------------------------------
expect m2 10.210.0.1 blocked.example.com "NOERROR 198.51.100.1"
expect m2 10.210.0.1 blocked.example.com "no answer" 10001
mpid=$(systemctl show -p MainPID --value qorpera-agent-exit-dns.service)
resolver_said="dnsmasq\[$r1\]: .*config blocked\.example\.com is NXDOMAIN"
main_said="dnsmasq\[$mpid\]: .*query\[A\] blocked\.example\.com from ${a2//./[.]}( |$)"
within 30 'dns_log_has "$resolver_said" && dns_log_has "$main_said"'
pass "m2 ($C2, no rules) resolves blocked.example.com through the main dnsmasq and gets no answer from C1's port; dns.log has the resolver's (pid $r1) NXDOMAIN and the main dnsmasq's (pid $mpid) question from $a2"

# --- A new rules version: a reload ----------------------------------------------------------------------------------
expect m1 10.210.0.1 fresh.example.com "NOERROR 198.51.100.1"
r1=$(main_pid 10001)
n1=$(restarts 10001)
rules "$C1=blocked.example.com,*.wild.example.com,fresh.example.com"
within 30 'says m1 10.210.0.1 fresh.example.com NXDOMAIN'
[[ $(main_pid 10001) == "$r1" && $(restarts 10001) == "$n1" ]] ||
	fail "the resolver was restarted (pid $r1 -> $(main_pid 10001), restarts $n1 -> $(restarts 10001))"
pass "a new version of $C1's rules blocks fresh.example.com, which the resolver had cached, within 30 s: a reload of the same dnsmasq (pid $r1, $n1 restarts)"

# --- C2 gets rules: its machines' open DNS flows end --------------------------------------------------------------
expect m2 9.9.9.9 other.example.com "NOERROR 198.51.100.1" 53 40053
rules "$C2=other.example.com"
c2_rules() {
	names_is "s['resolvers'] == {'$C1': 10001, '$C2': 10002} and s['mapped'] == {'$a1': 10001, '$a2': 10002} and s['problems'] == []" &&
		dns_is "$(pairs "$a1:10001" "$a2:10002")"
}
# The same flow (m2's port 40053 to 9.9.9.9:53) asked again and again while C2's resolver comes up: it stays open on
# the main dnsmasq until the reconciler ends it.
deadline=$((SECONDS + 30))
until c2_rules; do
	ask m2 9.9.9.9 other.example.com 53 40053 >/dev/null || true
	((SECONDS < deadline)) || fail "not within 30 s: c2_rules"
	sleep 0.5
done
expect m2 9.9.9.9 other.example.com NXDOMAIN 53 40053
expect m1 10.210.0.1 open.example.com "no answer" 10002
expect m2 10.210.0.1 open.example.com "no answer" 10001
expect m1 10.210.0.1 open.example.com "NOERROR 198.51.100.1" 10001
expect m2 10.210.0.1 open.example.com "NOERROR 198.51.100.1" 10002
expect m2 10.210.0.1 other.example.com NXDOMAIN 10002
pass "$C2's rules give it port 10002: m2's open flow from port 40053 to 9.9.9.9 is ended, its next question there is NXDOMAIN; each machine reaches its own company's port and not the other's"

# --- ROLLOUT.md step 9 on a running exit --------------------------------------------------------------------------
r1=$(main_pid 10001)
r2=$(main_pid 10002)
{
	bash "$here/install-agent-exit.sh" "$package" &&
		systemctl enable --now qorpera-agent-exit-names.service &&
		systemctl reload qorpera-agent-exit.service &&
		systemctl restart qorpera-agent-plug.service
} >"$work/step9.out" 2>&1 || fail "step 9: $(cat "$work/step9.out")"
grep -q '^Installed\. Nothing is started or enabled' "$work/step9.out" || fail "step 9: $(cat "$work/step9.out")"
within 30 'healthy && c2_rules'
[[ $(main_pid 10001) == "$r1" && $(main_pid 10002) == "$r2" ]] ||
	fail "step 9 restarted a resolver ($r1 $r2 -> $(main_pid 10001) $(main_pid 10002))"
pass "ROLLOUT.md step 9 on this running exit keeps both resolvers (pids $r1 $r2); healthy within 30 s with the map as it was"

# --- A killed resolver comes back ---------------------------------------------------------------------------------
r2=$(main_pid 10002)
kill -KILL "$r2"
back() {
	local pid
	pid=$(main_pid 10002)
	[[ $pid != 0 && $pid != "$r2" ]] && (($(restarts 10002) >= 1)) && says m2 10.210.0.1 other.example.com NXDOMAIN &&
		names_is "s['problems'] == []"
}
within 30 back
pass "C2's resolver, killed, is back within 30 s (pid $r2 -> $(main_pid 10002), $(restarts 10002) restarts), and blocks again"

# --- "Only listed" (E8c-1): TCP 443 to the addresses listed names were given ------------------------------------
# m2 holds a connection made in open mode (its output not on this script's, which the VM's exec waits to close); then
# C2 switches to "only listed" (listed.example.com). The resolver unit's own dnsmasq, in its sandbox and as nobody,
# puts each address it gives out in allow_10002.
in_m m2 python3 -c 'import socket, time; s = socket.create_connection(("198.51.100.2", 443)); time.sleep(600)' >/dev/null 2>&1 &
pids+=($!)
# Established only: a refused or closed one leaves an entry in another state.
held() { shows "ESTABLISHED src=$a2 dst=198.51.100.2 sport=[0-9]* dport=443" ip netns exec qexit conntrack -L -s "$a2" 2>/dev/null; }
within 30 held
r2=$(main_pid 10002)
asked=$(wc -l <"$work/upstream.log")
rules "$C2=only:other.example.com+listed.example.com"
only() {
	names_is "s['reach'] == {'$a1': 'open', '$a2': 'only_10002'} and s['problems'] == []" &&
		[[ $(reach_map) == "$(pairs "$a1:open" "$a2:only_10002")" && ! -e $RUN/names/10002.owed ]]
}
within 30 only
[[ $(main_pid 10002) != "$r2" && $(unit_state 10002) == active ]] ||
	fail "the switch did not restart C2's resolver ($r2 -> $(main_pid 10002), $(unit_state 10002))"
r2=$(main_pid 10002)
[[ $(cat "$RUN/names/10002.mode") == only-listed ]] || fail "10002.mode holds: $(cat "$RUN/names/10002.mode")"
held && fail "m2's connection made before the switch goes on"
[[ -z $(set_addresses allow_10002) ]] || fail "allow_10002 holds $(set_addresses allow_10002) before a listed name was asked"
expect_tcp m2 198.51.100.1 443 refused
for server in 10.210.0.1 9.9.9.9; do
	expect m2 "$server" open.example.com NXDOMAIN
	expect m2 "$server" other.example.com NXDOMAIN
done
page=$(in_m m2 python3 -c 'import urllib.request; print(urllib.request.urlopen("http://listed.example.com:443/", timeout=5).read().decode())' 2>&1) ||
	fail "m2 could not fetch http://listed.example.com:443/: $page"
[[ $page == ok ]] || fail "m2 fetched http://listed.example.com:443/: $page"
[[ $(set_addresses allow_10002) == 198.51.100.1 ]] || fail "allow_10002 holds: $(set_addresses allow_10002)"
expect_tcp m2 198.51.100.1 80 refused
expect_tcp m2 198.51.100.2 443 refused
expect_tcp m1 198.51.100.2 443 open
expect m2 10.210.0.1 two.listed.example.com "NOERROR 198.51.100.2"
expect_tcp m2 198.51.100.2 443 open
shows '^open\.example\.com ' tail -n "+$((asked + 1))" "$work/upstream.log" && fail "an unlisted name of m2's reached the upstreams"
healthy || fail "not healthy with C2 only listed: $(verify_problems)"
pass "$C2 switched to only listed.example.com: its resolver restarted (pid $r2) and m2's connection made before ended; unlisted names are NXDOMAIN and never reach the upstreams; m2 reaches TCP 443 only on the addresses its resolver gave out (put in allow_10002 by the unit's own dnsmasq), never port 80 or another address; m1 (open) reaches any"

# The exit's reload (up, as ROLLOUT.md step 9 runs it) builds the table again with allow_10002 empty: the reconciler
# reloads C2's resolver (its cache emptied), so a listed name asked again puts its address back.
systemctl reload qorpera-agent-exit.service
within 30 'only && [[ -z $(set_addresses allow_10002) ]]'
expect_tcp m2 198.51.100.1 443 refused
within 30 'says m2 10.210.0.1 listed.example.com "NOERROR 198.51.100.1" && [[ $(set_addresses allow_10002) == 198.51.100.1 ]]'
expect_tcp m2 198.51.100.1 443 open
[[ $(main_pid 10002) == "$r2" ]] || fail "the exit's reload restarted C2's resolver ($r2 -> $(main_pid 10002))"
within 30 healthy
pass "the exit's reload empties allow_10002 and keeps C2's resolver (pid $r2), reloaded: listed.example.com asked again reaches 198.51.100.1 again"

# A narrower list restarts the resolver with allow_10002 emptied and ends m2's connections again. The reload emptied
# the set, so two.listed.example.com is asked again for m2's connection to its address.
expect m2 10.210.0.1 two.listed.example.com "NOERROR 198.51.100.2"
in_m m2 python3 -c 'import socket, time; s = socket.create_connection(("198.51.100.2", 443)); time.sleep(600)' >/dev/null 2>&1 &
pids+=($!)
within 30 held
rules "$C2=only:other.example.com+two.listed.example.com"
within 30 'says m2 10.210.0.1 listed.example.com NXDOMAIN && only'
[[ $(main_pid 10002) != "$r2" ]] || fail "a narrower list did not restart C2's resolver"
held && fail "m2's connection made before the narrower list goes on"
expect_tcp m2 198.51.100.1 443 refused
expect_tcp m2 198.51.100.2 443 refused
expect m2 10.210.0.1 two.listed.example.com "NOERROR 198.51.100.2"
expect_tcp m2 198.51.100.2 443 open
pass "a narrower list restarts C2's resolver (pid $(main_pid 10002)) with allow_10002 emptied and ends m2's connections"

# Back to open: the resolver restarted without the set; the chain and the set go; m2 reaches any address.
rules "$C2=other.example.com"
within 30 "names_is \"s['reach'] == {'$a1': 'open', '$a2': 'open'} and s['problems'] == []\" && [[ \$(reach_map) == \"$(pairs "$a1:open" "$a2:open")\" ]]"
within 30 'says m2 10.210.0.1 open.example.com "NOERROR 198.51.100.1"'
within 30 '! ip netns exec qexit nft list chain inet qorpera_agent_exit only_10002 >/dev/null 2>&1'
ip netns exec qexit nft list set inet qorpera_agent_exit allow_10002 >/dev/null 2>&1 && fail "allow_10002 stayed"
expect m2 10.210.0.1 other.example.com NXDOMAIN
expect_tcp m2 198.51.100.2 443 open
expect_tcp m2 198.51.100.1 80 open
within 30 healthy
pass "$C2 back to open: its resolver asks for every name again, only_10002 and allow_10002 go, m2 reaches any address"

# --- The exit fails closed -----------------------------------------------------------------------------------------
rules "$C2=bad"
within 30 "names_is \"'$a2' not in s['mapped']\""
refused=$(refused_dns)
expect m2 10.210.0.1 open.example.com "no answer"
expect m2 9.9.9.9 open.example.com "no answer"
(($(refused_dns) >= refused + 2)) || fail "refused_dns went from $refused to $(refused_dns)"
[[ $(reach_map) == "$a1:open" ]] || fail "the reach map with C2's rules not usable: $(reach_map)"
expect_tcp m2 198.51.100.1 80 refused
expect_tcp m1 198.51.100.1 80 open
c2_bad="$NOT_HEALTHY names: $C2: its rules are not as the rules reader writes them; its machines get no DNS and no way out"
within 30 '[[ $(unit_state 10002) == inactive && ! -e $RUN/names/10002.servers ]] && verify_says "$c2_bad"'
pass "rules the reader never writes leave m2 no DNS, to the exit or to 9.9.9.9 (refused_dns counts it), and no way out; stop C2's resolver and remove its file; verify says why"

rules "$C2=other.example.com"
within 30 "names_is \"'$C2' in s['resolvers'] and s['mapped'].get('$a2') == s['resolvers']['$C2'] and s['mapped'].get('$a1') == 10001 and s['problems'] == []\""
p2=$(names_get "s['resolvers']['$C2']")
expect m2 10.210.0.1 other.example.com NXDOMAIN
both_rules() {
	names_is "s['resolvers'] == {'$C1': 10001, '$C2': $p2} and s['mapped'] == {'$a1': 10001, '$a2': $p2} and s['problems'] == []" &&
		dns_is "$(pairs "$a1:10001" "$a2:$p2")"
}
touch "$db.pause"
# A pass of the stand-in under way when it was paused writes no more after this.
sleep 1
rm -f "$STATE/rules/rules.json"
within 30 'names_is "s['"'"'mapped'"'"'] == {}" && dns_is "" && [[ -z $(reach_map) ]] && verify_says "$NO_RULES_FILE"'
expect_tcp m1 198.51.100.1 80 refused
rm -f "$db.pause"
within 30 'healthy && both_rules'
pass "C2's rules back: its resolver on port $p2; with no rules file no machine has DNS or a way out and verify says why; the file back, the exit is healthy again with the map as before"

# --- The last machine of a company goes ---------------------------------------------------------------------------
lx delete --force m2 >/dev/null
m2_gone() {
	names_is "s['resolvers'] == {'$C1': 10001} and s['mapped'] == {'$a1': 10001}" &&
		[[ $(unit_state "$p2") == inactive && ! -e $RUN/names/$p2.servers ]] &&
		cmp -s "$STATE/names/ports.json" <(printf '{"%s": 10001}\n' "$C1")
}
within 30 m2_gone
# The plug unplugged m2 and reloaded the main dnsmasq for its lease file: a reload under the dns unit's sandbox.
dns_journal() { journalctl --no-pager -o cat -u qorpera-agent-exit-dns.service 2>/dev/null || true; }
within 30 '[[ $(dns_journal) == *"Reloaded qorpera-agent-exit-dns.service"* ]]'
journal=$(dns_journal)
[[ $journal != *"Reload failed"* && $journal != *"not permitted"* ]] || fail "the dns unit's reload failed: $journal"
pass "m2 deleted: C2's resolver stops within 30 s, its file goes and its port is given back (ports.json holds only $C1's); the plug's reload of the main dnsmasq succeeds"

# --- The exit's stop: step 1's undo --------------------------------------------------------------------------------
# The names reconciler is stopped (SIGSTOP) first, so C1's resolver still runs when the exit stops: the exit's stop
# itself must stop it.
systemctl kill -s STOP qorpera-agent-exit-names.service
lx delete --force m1 >/dev/null
within 60 '! compgen -G "$STATE/clients/*.json" >/dev/null'
[[ $(unit_state 10001) == active ]] || fail "C1's resolver is $(unit_state 10001) before the stop"
kill "$reader_pid" 2>/dev/null || true
wait "$reader_pid" 2>/dev/null || true
{
	systemctl disable --now qorpera-agent-exit-health.timer qorpera-agent-exit-logs.timer qorpera-agent-exit-ship.timer qorpera-agent-exit.service && systemctl disable qorpera-agent-exit-dns.service qorpera-agent-exit-log.service qorpera-agent-plug.service qorpera-agent-exit-names.service
} >"$work/undo.out" 2>&1 || fail "step 1's undo: $(cat "$work/undo.out")"
all_off() {
	local units enabled tables
	units=$(systemctl list-units --all --plain --no-legend --full 'qorpera-agent-*' 2>/dev/null) || return 1
	# A failed unit's line may start with a mark; the unit's name is the first field that is one.
	[[ -z $(awk '{ i = ($1 ~ /^qorpera-agent-/) ? 1 : 2; if ($(i + 2) != "inactive") print }' <<<"$units") ]] || return 1
	enabled=$(systemctl list-unit-files --state=enabled --no-legend 'qorpera-agent-*' 2>/dev/null || true)
	[[ -z $enabled ]] || return 1
	[[ -z $(active_resolvers) ]] || return 1
	[[ ! -e /run/netns/qexit && ! -e /sys/class/net/qagent0 ]] || return 1
	tables=$(nft list tables) || return 1
	! grep -q qorpera_agent_exit <<<"$tables"
}
within 30 all_off
pass "step 1's undo with C1's resolver running and the names reconciler stopped: within 30 s every qorpera-agent-* unit is inactive and none enabled, no resolver runs, and no namespace, bridge or nft table of the exit is left"

# --- Step 9 or 10 from the previous release, and its undo ---------------------------------------------------------
# Step 9 (E8b-2) from a release before E8b-2; step 10 (E8c-1) from one with E8b-2 (it has the names tool).
if [[ -z $previous ]]; then
	echo "SKIP: step 9 or 10 from a previous release and its undo (no QORPERA_AGENT_EXIT_PROOF_PREVIOUS)"
else
	step=9 names_unit=()
	if [[ -e $previous/qorpera-agent-exit-names.py ]]; then
		step=10 names_unit=(qorpera-agent-exit-names.service)
	fi
	rm -rf /usr/local/libexec/qorpera-agent-exit "$STATE" "$RUN" "$LOGS" /etc/systemd/system/qorpera-agent-exit* \
		/etc/systemd/system/qorpera-agent-plug.service
	systemctl daemon-reload
	systemctl reset-failed
	bash "$previous/install-agent-exit.sh" "$package" >"$work/install-previous.out" 2>&1 ||
		fail "the previous release's install: $(cat "$work/install-previous.out")"
	grep -q '^Installed\. Nothing is started or enabled' "$work/install-previous.out" ||
		fail "the previous release's install: $(cat "$work/install-previous.out")"
	install -d -m 0700 "$STATE/rules"
	install -d -m 0755 /run/qorpera-agent-exit-rules
	if ((step == 10)); then
		# E8b-2 runs "only listed" as its block list alone, every other name answered.
		rules "$C1=only:blocked.example.com+listed.example.com"
	fi
	# The previous release's step 1 (with E8b-2: its names reconciler too).
	{
		systemctl enable --now qorpera-agent-exit.service qorpera-agent-exit-dns.service qorpera-agent-exit-log.service \
			qorpera-agent-plug.service "${names_unit[@]}" qorpera-agent-exit-health.timer qorpera-agent-exit-logs.timer \
			qorpera-agent-exit-ship.timer &&
			systemctl start qorpera-agent-exit-ship.service
	} >"$work/previous-step1.out" 2>&1 || fail "the previous release's step 1: $(cat "$work/previous-step1.out")"
	start_reader
	within 120 healthy
	a3=$(machine m3 "$C1") || fail "cannot plug in and start m3"
	within 180 '[[ $(lease_of m3) == "$a3" ]]'
	lx file push "$work/rcode.py" m3/root/rcode.py >/dev/null
fi
if [[ -n $previous ]] && ((step == 9)); then
	within 30 'says m3 10.210.0.1 blocked.example.com "NOERROR 198.51.100.1"'
	# A flow from m3's port 40054 to 9.9.9.9:53 that the previous release sent to the main dnsmasq. Asked twice, over
	# 2 s apart, so the kernel keeps it 120 s without a packet: it outlasts step 9 below.
	expect m3 9.9.9.9 blocked.example.com "NOERROR 198.51.100.1" 53 40054
	sleep 2.5
	expect m3 9.9.9.9 blocked.example.com "NOERROR 198.51.100.1" 53 40054
	pass "the previous release, installed and switched on with its own step 1, is healthy; m3 ($C1) at $a3 resolves blocked.example.com, also on a flow from its port 40054 to 9.9.9.9"

	{
		bash "$here/install-agent-exit.sh" "$package" &&
			systemctl enable --now qorpera-agent-exit-names.service &&
			systemctl restart qorpera-agent-exit-log.service &&
			systemctl reload qorpera-agent-exit.service &&
			systemctl restart qorpera-agent-plug.service
	} >"$work/step9-b.out" 2>&1 || fail "step 9: $(cat "$work/step9-b.out")"
	stepped() {
		healthy && says m3 10.210.0.1 blocked.example.com NXDOMAIN &&
			names_is "s['resolvers'] == {'$C1': 10001} and s['mapped'] == {'$a3': 10001} and s['problems'] == []"
	}
	# `up` made the exit's table again, its map from the files, maybe with m3 already on its company's resolver. The flow
	# from port 40054, asked again and again meanwhile, ends either way: the reconciler ends every machine's DNS
	# connections once in each table it has not seen.
	deadline=$((SECONDS + 30))
	until stepped; do
		ask m3 9.9.9.9 blocked.example.com 53 40054 >/dev/null || true
		((SECONDS < deadline)) || fail "not within 30 s: stepped"
		sleep 0.5
	done
	expect m3 9.9.9.9 blocked.example.com NXDOMAIN 53 40054
	[[ $(reach_map) == "$a3:open" ]] || fail "reach after step 9: $(reach_map)"
	expect_tcp m3 198.51.100.1 80 open
	pass "ROLLOUT.md step 9 on the previous release's exit: healthy within 30 s, $C1 has its resolver on port 10001 and m3 its blocked names, also on its flow from port 40054 opened before the step; reach sends m3 to open and it reaches 198.51.100.1:80"

	{
		bash "$previous/install-agent-exit.sh" "$package" &&
			systemctl reload qorpera-agent-exit.service &&
			systemctl disable --now qorpera-agent-exit-names.service &&
			systemctl stop 'qorpera-agent-exit-resolver@*.service' &&
			rm -f "$RUN"/names/*.mode "$RUN"/names/*.owed &&
			systemctl restart qorpera-agent-plug.service qorpera-agent-exit-log.service
	} >"$work/step9-undo.out" 2>&1 || fail "step 9's undo: $(cat "$work/step9-undo.out")"
	undone() {
		says m3 10.210.0.1 blocked.example.com "NOERROR 198.51.100.1" && [[ -z $(active_resolvers) ]] &&
			[[ $(systemctl is-active qorpera-agent-exit-names.service 2>/dev/null || true) == inactive ]] &&
			[[ $(systemctl is-enabled qorpera-agent-exit-names.service 2>/dev/null || true) == disabled ]] &&
			healthy
	}
	within 30 undone
	expect_tcp m3 198.51.100.1 80 open
	pass "step 9's undo: within 30 s m3 resolves blocked.example.com again, no resolver runs, the names unit is off and disabled, and the previous release's exit is healthy; m3 reaches 198.51.100.1:80"
elif [[ -n $previous ]]; then
	# E8b-2 runs C1's resolver with its block list alone: every other name is answered and m3 goes anywhere. m3 holds a
	# connection through step 10 (its output not on this script's, which the VM's exec waits to close).
	within 30 'says m3 10.210.0.1 blocked.example.com NXDOMAIN && says m3 10.210.0.1 open.example.com "NOERROR 198.51.100.1"'
	expect_tcp m3 198.51.100.1 80 open
	in_m m3 python3 -c 'import socket, time; s = socket.create_connection(("198.51.100.1", 80)); time.sleep(600)' >/dev/null 2>&1 &
	pids+=($!)
	held3() { shows "dst=198.51.100.1 sport=[0-9]* dport=80" ip netns exec qexit conntrack -L -s "$a3" 2>/dev/null; }
	within 30 held3
	r1=$(main_pid 10001)
	pass "the previous release (E8b-2), installed and switched on with its own step 1, is healthy; m3 ($C1, \"only listed\") at $a3 has blocked.example.com blocked and open.example.com answered, reaches 198.51.100.1:80 and holds a connection there"

	{
		bash "$here/install-agent-exit.sh" "$package" &&
			systemctl restart qorpera-agent-exit-names.service qorpera-agent-exit-log.service &&
			systemctl reload qorpera-agent-exit.service &&
			systemctl restart qorpera-agent-plug.service
	} >"$work/step10.out" 2>&1 || fail "step 10: $(cat "$work/step10.out")"
	stepped() {
		healthy && names_is "s['reach'] == {'$a3': 'only_10001'} and s['problems'] == []" &&
			[[ $(reach_map) == "$a3:only_10001" && $(cat "$RUN/names/10001.mode" 2>/dev/null) == only-listed ]] &&
			[[ ! -e $RUN/names/10001.owed ]]
	}
	within 30 stepped
	[[ $(main_pid 10001) != "$r1" ]] || fail "step 10 did not restart $C1's resolver (pid $r1)"
	held3 && fail "m3's connection made before step 10 goes on"
	expect m3 10.210.0.1 open.example.com NXDOMAIN
	expect m3 10.210.0.1 blocked.example.com NXDOMAIN
	expect_tcp m3 198.51.100.1 80 refused
	expect m3 10.210.0.1 listed.example.com "NOERROR 198.51.100.1"
	expect_tcp m3 198.51.100.1 443 open
	pass "ROLLOUT.md step 10 on the previous release's exit: healthy within 30 s, $C1's resolver restarted into \"only listed\" (open.example.com is NXDOMAIN), m3's connection made before ended, and after asking for listed.example.com m3 reaches 198.51.100.1 on 443 and not on 80"

	{
		bash "$previous/install-agent-exit.sh" "$package" &&
			systemctl reload qorpera-agent-exit.service &&
			systemctl restart qorpera-agent-exit-names.service &&
			rm -f "$RUN"/names/*.mode "$RUN"/names/*.owed &&
			systemctl stop 'qorpera-agent-exit-resolver@*.service' &&
			systemctl restart qorpera-agent-plug.service qorpera-agent-exit-log.service
	} >"$work/step10-undo.out" 2>&1 || fail "step 10's undo: $(cat "$work/step10-undo.out")"
	undone() {
		healthy && [[ $(unit_state 10001) == active && ! -e $RUN/names/10001.mode ]] &&
			says m3 10.210.0.1 open.example.com "NOERROR 198.51.100.1" && says m3 10.210.0.1 blocked.example.com NXDOMAIN
	}
	within 30 undone
	expect_tcp m3 198.51.100.1 80 open
	pass "step 10's undo: within 30 s the previous release's exit is healthy and runs $C1's resolver on port 10001 again; m3 has blocked.example.com blocked, open.example.com answered and reaches 198.51.100.1:80"
fi

echo "ALL PASSED"
