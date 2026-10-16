#!/usr/bin/env bash
# The rules reader (E8b) under systemd, inside the throwaway VM test/prove-rules-reader-vm.sh makes (never on a node,
# never on a shared test machine: it installs the exit's units, a group, a user and a login). It installs the exit and
# the reader's package with install-agent-exit.sh, plugs two machines in as a creator does, places a login with the
# tool's `database-url` as the rollout script does, and starts the reader with `rules-start`. The login names a
# stand-in server in this VM that answers Postgres's TLS request with a certificate of its own. It checks what the
# Docker proof and the unit tests cannot:
# - the installer on Ubuntu 26.04 with its own Node (the nodes' nodejs package) and coreutils: a changed package
#   refused with nothing installed, then the package taken and nothing started or enabled;
# - that without its login the reader does not start;
# - systemd's dynamic user, the two credentials as systemd hands them over (the reader checks them as the broker does),
#   the link to its state folder and its runtime folder;
# - that the reader reads the client map as a creator writes it, asks the login's server over TLS only, refuses a
#   certificate not from Supabase's CA before it sends anything, keeps no rules without a read, and says why in its
#   status and in `rules-start`'s answer;
# - that the login reaches no log, and that the undo leaves the reader off with nothing of the login behind.
# A read that succeeds needs Supabase itself: the rollout script's last step proves it on the nodes.
# Prints PASS lines, then ALL PASSED.
set -euo pipefail

here=${QORPERA_AGENT_EXIT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
package=${QORPERA_AGENT_EXIT_RULES_PACKAGE:?the rules reader package folder}
X=/usr/local/libexec/qorpera-agent-exit/qorpera-agent-exit.sh
PLUG=/usr/local/libexec/qorpera-agent-exit/qorpera-agent-plug.py
UNIT=qorpera-agent-exit-rules.service
STATUS=/run/qorpera-agent-exit-rules/status.json
LOGIN=/etc/qorpera-agent-exit/database-url
STATE=/var/lib/qorpera-agent-exit
COMPANY=0f6c2b1e-4d3a-4b5c-8e9f-0123456789ab
# The TLS failures a certificate that is not from the pinned CA can give (Node's codes).
TLS_REFUSALS='DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|ERR_TLS_CERT_ALTNAME_INVALID'

password=
fail() {
	echo "FAIL: $*" >&2
	diagnose >&2 || true
	exit 1
}
pass() { echo "PASS: $*"; }
# Never the login: the journal lines that hold the password (there should be none) are left out.
diagnose() {
	echo "--- $UNIT"
	systemctl show -p ActiveState -p Result -p ExecMainStatus -p NRestarts "$UNIT" 2>&1
	journalctl -u "$UNIT" --no-pager -o cat -n 20 2>&1 | if [[ -n $password ]]; then grep -vF -- "$password"; else cat; fi
	echo "--- status"
	cat "$STATUS" 2>&1
	echo "--- server"
	cat "${work:-/nonexistent}/server.log" 2>&1
}
package_of() { dpkg -S "$(readlink -f "$1")" 2>/dev/null | cut -d: -f1 | head -1 || true; }
wait_for() {
	local i
	for i in $(seq 1 100); do
		if eval "$1"; then return 0; fi
		sleep 0.1
	done
	fail "timed out waiting for: $1"
}

[[ $(id -u) -eq 0 ]] || fail "run as root"
[[ -e /etc/qorpera-throwaway-vm ]] || fail "this proof runs only inside the throwaway VM of test/prove-rules-reader-vm.sh"
for part in /usr/local/libexec/qorpera-agent-exit /etc/qorpera-agent-exit "$STATE" "/etc/systemd/system/$UNIT"; do
	[[ ! -e $part ]] || fail "$part exists"
done
for tool in openssl setpriv useradd nft; do command -v "$tool" >/dev/null || fail "missing $tool"; done

work=$(mktemp -d)
server_pid=
cleanup() {
	set +e
	[[ -z $server_pid ]] || kill "$server_pid" 2>/dev/null
	rm -rf "$work"
}
trap cleanup EXIT

# --- The installer ------------------------------------------------------------------------------------------------
getent group qorpera-agent-plug >/dev/null || groupadd --system qorpera-agent-plug
cp -r "$package" "$work/changed"
printf ' ' >>"$work/changed/qorpera-agent-exit-rules.mjs"
if bash "$here/install-agent-exit.sh" "$work/changed" >"$work/changed.out" 2>&1; then
	fail "the installer took a changed package"
fi
grep -q 'not a rules reader package' "$work/changed.out" || fail "the installer's answer: $(cat "$work/changed.out")"
[[ ! -e /usr/local/libexec/qorpera-agent-exit ]] || fail "a refused package installed something"
bash "$here/install-agent-exit.sh" "$package" >"$work/install.out" 2>&1 || fail "install: $(cat "$work/install.out")"
grep -q '^Installed\. Nothing is started or enabled' "$work/install.out" || fail "install: $(cat "$work/install.out")"
[[ $(systemctl is-enabled "$UNIT" 2>&1) == disabled ]] || fail "the installer enabled the reader"
! systemctl is-active --quiet "$UNIT" || fail "the installer started the reader"
pass "install-agent-exit.sh refuses a changed package with nothing installed, then takes the package (Node $(/usr/bin/node --version), $(package_of /usr/bin/node) $(dpkg-query -W -f='${Version}' nodejs 2>/dev/null || true)) and starts nothing"

# --- The client map, as the exit's `up` makes it and a creator writes it ------------------------------------------
install -d -m 0755 /run/qorpera-agent-exit "$STATE" "$STATE/quarantine" "$STATE/seen" "$STATE/verified"
install -d -m 0750 /var/log/qorpera-agent-exit
install -d -m 3775 -g qorpera-agent-plug "$STATE/clients" "$STATE/dhcp-hosts"
install -m 0644 /dev/null "$STATE/plug.lock"
useradd --system --no-create-home --shell /usr/sbin/nologin --groups qorpera-agent-plug qcreator
as_creator() { setpriv --reuid=qcreator --regid=qcreator --init-groups -- sh -c 'umask 077; exec "$@"' sh "$@"; }
as_creator python3 "$PLUG" plug --kind machine --company "$COMPANY" --machine m1 --project machines --instance vm1 \
	>/dev/null || fail "plug as a creator"
# A company that is no UUID: the plug takes it, the reader skips it.
as_creator python3 "$PLUG" plug --kind machine --company c0 --machine m2 --project machines --instance vm2 \
	>/dev/null || fail "plug as a creator"
[[ $(find "$STATE/clients" -name '*.json' -perm 0644 | wc -l) == 2 ]] || fail "the client entries: $(ls -l "$STATE/clients")"
pass "two machines plugged in by a creator (umask 077): entries 0644 in the plug group's client map"

# --- No login, no reader -----------------------------------------------------------------------------------------
if systemctl start "$UNIT" 2>/dev/null; then fail "the reader started without its login"; fi
[[ ! -e $STATUS ]] || fail "the reader ran without its login"
no_login="$(systemctl show -p Result --value "$UNIT") $(systemctl show -p ExecMainStatus --value "$UNIT")"
systemctl stop "$UNIT" 2>/dev/null || true
systemctl reset-failed "$UNIT" 2>/dev/null || true
pass "without its login the reader does not start (systemd: $no_login)"

# --- The stand-in server: Postgres's TLS request, then a handshake with its own certificate ------------------------
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj /CN=127.0.0.1 \
	-addext subjectAltName=IP:127.0.0.1 -keyout "$work/server.key" -out "$work/server.crt" >/dev/null 2>&1 ||
	fail "openssl could not make the stand-in's certificate"
python3 - "$work/server.crt" "$work/server.key" "$work/server.log" <<'EOF' &
import socket, ssl, sys

context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[1], sys.argv[2])
server = socket.create_server(("127.0.0.1", 6543))
log = open(sys.argv[3], "a", buffering=1)
log.write("listening\n")
# Postgres's SSLRequest: length 8, code 80877103.
SSL_REQUEST = bytes.fromhex("0000000804d2162f")
while True:
    connection, _ = server.accept()
    with connection:
        connection.settimeout(5)
        try:
            if connection.recv(8) != SSL_REQUEST:
                log.write("other\n")
                continue
            log.write("sslrequest\n")
            connection.sendall(b"S")
            with context.wrap_socket(connection, server_side=True) as tls:
                log.write("handshake\n")
                if tls.recv(4096):
                    log.write("startup\n")
        except (OSError, ssl.SSLError):
            log.write("refused\n")
EOF
server_pid=$!
wait_for 'grep -q listening "$work/server.log" 2>/dev/null'

# --- The login, as the rollout script places it -------------------------------------------------------------------
# A throwaway password for the stand-in, in the one form the script makes; never printed.
password=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
login="postgresql://qorpera_agent_exit.abcdefghij0123456789:$password@127.0.0.1:6543/postgres?sslmode=verify-full"
out=$(printf '%s' "$login" | "$X" database-url) || fail "database-url failed"
login_sha256=$(printf '%s' "$login" | sha256sum | cut -d' ' -f1)
[[ $out == "$LOGIN mode=400 owner=root:root bytes=${#login} sha256=$login_sha256" ]] || fail "database-url: $out"
[[ $(stat -c '%a %U:%G' /etc/qorpera-agent-exit) == "700 root:root" ]] || fail "the login folder is not root's alone"
[[ $(ls -A /etc/qorpera-agent-exit) == database-url ]] || fail "the login folder: $(ls -A /etc/qorpera-agent-exit)"
pass "database-url writes the login root-only (0400 in a 0700 folder) with $(package_of "$(command -v mv)")'s mv, sync and stat, and prints its sha256"

# --- rules-start: the reader runs, asks the stand-in over TLS and refuses its certificate --------------------------
started=$(date +%s)
if "$X" rules-start >"$work/start.out" 2>&1; then fail "rules-start: $(cat "$work/start.out")"; fi
problem=$(sed -n 's/^qorpera-agent-exit: the rules reader has not read the database in 30 s (problem \([A-Z0-9_]*\))$/\1/p' \
	"$work/start.out")
[[ $problem =~ ^($TLS_REFUSALS)$ ]] || fail "rules-start: $(cat "$work/start.out")"
(($(date +%s) - started >= 30)) || fail "rules-start gave up early"
[[ $(systemctl is-enabled "$UNIT") == enabled ]] || fail "rules-start did not enable the reader"
systemctl is-active --quiet "$UNIT" || fail "the reader is not running"
[[ $(systemctl show -p NRestarts --value "$UNIT") == 0 ]] || fail "the reader restarted"
pass "rules-start enables and starts the reader, waits 30 s and names its problem ($problem)"

pid=$(systemctl show -p MainPID --value "$UNIT")
uid=$(ps -o uid= -p "$pid" | tr -d ' ')
gid=$(ps -o gid= -p "$pid" | tr -d ' ')
((uid >= 61184 && uid <= 65519)) || fail "the reader runs as uid $uid, not a dynamic user"
[[ $(readlink /var/lib/qorpera-agent-exit/rules) == ../private/qorpera-agent-exit/rules ]] ||
	fail "the state link: $(ls -l /var/lib/qorpera-agent-exit/rules 2>&1)"
[[ $(stat -c '%a %U:%G' /var/lib/private) == "700 root:root" ]] || fail "/var/lib/private is not root's alone"
# On disk the folder is the dynamic user's, or, where systemd maps it into the reader's namespace with an id-mapped
# mount (Ubuntu 26.04's), nobody's; in the reader's namespace it is the reader's own either way, and it writes there.
on_disk=$(stat -c '%a %u' /var/lib/private/qorpera-agent-exit/rules)
[[ $on_disk == "700 $uid" || $on_disk == "700 65534" ]] ||
	fail "the state folder: $(stat -c '%a %U' /var/lib/private/qorpera-agent-exit/rules)"
[[ -z $(ls -A /var/lib/private/qorpera-agent-exit/rules) ]] || fail "rules kept without a read"
[[ $(nsenter --target "$pid" --mount stat -L -c '%a %u' "$STATE/rules") == "700 $uid" ]] ||
	fail "the state folder in the reader's namespace: $(nsenter --target "$pid" --mount stat -L -c '%a %u' "$STATE/rules" 2>&1)"
nsenter --target "$pid" --mount --setgid "$gid" --setuid "$uid" -- \
	sh -c 'probe=$1/.prove-rules-reader; : >"$probe" && rm "$probe"' sh "$STATE/rules" ||
	fail "the reader's user cannot write its state folder"
[[ $(stat -c '%a %u' /run/qorpera-agent-exit-rules) == "755 $uid" ]] ||
	fail "the runtime folder: $(stat -c '%a %U:%G' /run/qorpera-agent-exit-rules)"
credentials=/run/credentials/$UNIT
seen=$(stat -c '%n %a %U:%G' "$credentials"/* 2>/dev/null | sed "s|$credentials/||" | tr '\n' ';' || true)
pass "the reader runs as dynamic user $uid with both credentials (as systemd hands them: ${seen:-not visible from here}), its state folder linked from $STATE/rules (0700, empty, uid ${on_disk#* } on disk, the reader's own and writable in its namespace) and its runtime folder its own"

[[ $(stat -c %a "$STATUS") == 644 ]] || fail "status.json is mode $(stat -c %a "$STATUS")"
python3 - "$STATUS" "$problem" <<'EOF' || fail "status.json: $(cat "$STATUS")"
import json, sys

with open(sys.argv[1], encoding="utf-8") as f:
    status = json.load(f)
assert sorted(status) == sorted(["schema", "checkedAt", "readAt", "ok", "problem", "companies", "withRules",
                                 "badRows", "skipped"]), status
assert status["schema"] == "qorpera.agent-exit-rules-status/v1", status
assert status["readAt"] is None and status["ok"] is False and status["problem"] == sys.argv[2], status
# The creator's two entries read: the one whose company is no UUID skipped, nothing unreadable.
assert (status["companies"], status["withRules"], status["badRows"], status["skipped"]) == (0, 0, 0, 1), status
EOF
grep -qx sslrequest "$work/server.log" || fail "the reader never asked the stand-in for TLS"
grep -qx refused "$work/server.log" || fail "the stand-in saw no refused handshake"
! grep -qxE 'other|handshake|startup' "$work/server.log" || fail "the reader went past the certificate: $(sort -u "$work/server.log")"
pass "status.json (0644): not read, problem $problem, the client map read (1 entry skipped); the stand-in saw only TLS requests and refused handshakes"

# --- The login in no log -------------------------------------------------------------------------------------------
journalctl --sync 2>/dev/null || true
# The journal is read whole first: piped into grep -q, journalctl dies of SIGPIPE after a match, and `!` would pass.
journal=$(journalctl --no-pager -o cat 2>/dev/null || true)
[[ $journal != *"$password"* ]] || fail "the login is in the journal"
! grep -rqF -- "$password" /var/log /run/qorpera-agent-exit-rules /var/lib/private 2>/dev/null ||
	fail "the login is in a file it does not belong in"
lines=$(journalctl -u "$UNIT" --no-pager -o cat | grep -c '^Agent exit rules' || true)
[[ $(journalctl -u "$UNIT" --no-pager -o cat | grep '^Agent exit rules' | sort -u) == "Agent exit rules: cannot read the rules ($problem); the last rules stay." ]] ||
	fail "the reader's journal: $(journalctl -u "$UNIT" --no-pager -o cat | grep '^Agent exit rules' | sort -u)"
pass "the login is in no log; the reader's journal has its one state line ($lines in all)"

# --- The undo (README.md, "Adding E8b to a node that runs the exit") -----------------------------------------------
systemctl disable --now --quiet "$UNIT"
rm "$LOGIN"
[[ $(systemctl is-enabled "$UNIT" 2>&1) == disabled ]] || fail "the reader is still enabled"
! systemctl is-active --quiet "$UNIT" || fail "the reader still runs"
[[ ! -e $credentials && ! -e /run/qorpera-agent-exit-rules ]] || fail "the reader's credentials or runtime folder stayed"
if systemctl start "$UNIT" 2>/dev/null; then fail "the reader started after the undo"; fi
systemctl stop "$UNIT" 2>/dev/null || true
systemctl reset-failed "$UNIT" 2>/dev/null || true
pass "the undo leaves the reader disabled and stopped, its credentials gone and no login to start with"
echo "ALL PASSED"
