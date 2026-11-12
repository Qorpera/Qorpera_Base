#!/usr/bin/env bash
# The coding machine image, checked from inside a machine made from it (5f), as root. test/prove-coding-image.sh makes
# that machine in a throwaway project on a test machine and pushes this in; never run it anywhere else. It sets up one
# session the way the guest agent (5g) will, with a plain folder standing in for the folder program's mount, and runs
# that session's commands as 5g's units will (its uid, its slice, ProtectProc=invisible, PrivateIPC=yes, /company
# bound), then checks:
# - the machine: no /dev/lxd, its root grown to the disk, its network and name without cloud-init, the self-updates
#   masked, the pinned tools;
# - the session: its user in the sudo group, NOPASSWD sudo, its rootless Docker daemon started on first
#   use, compose running a two-service app (a build, a published port, /company bound into a container), stdin closed
#   half-way through the socket, container limits, `sudo docker` reaching the system daemon (which leaves the
#   FORWARD policy at ACCEPT), Chromium with its
#   sandbox, tmux, the pinned git, and the toolbox and languages of the contract's 2026-10-14 amendment (items 7 and
#   11): TypeScript (tsc, tsx, node), C and C++ (gcc, clang), Ruby, Python with uv, mise installing a language in the
#   user's home, LibreOffice converting a document, and sqlite3, zip and unzip;
# - a repository's checks and site (own code storage, steps 3 and 4): the executor's own clean copy, collect and drop
#   (QORPERA_PROOF_SCRIPTS, printed by test/code-checks-scripts.mjs), run as the session's commands are, on a
#   repository's storage in the session's /company.
# Prints PASS lines, then ALL PASSED.
set -euo pipefail

W32=${QORPERA_PROOF_WORKER32:-0123456789abcdef0123456789abcdef}
SESSION_UID=200001
NAME=qorpera-$SESSION_UID
HOMEDIR=/home/$NAME
MOUNT=/run/qorpera-folder/mounts/$W32
GIT_VERSION=${QORPERA_PROOF_GIT:?the pinned git version}
NODE_VERSION=${QORPERA_PROOF_NODE:?the pinned Node version}
CHROMIUM_VERSION=${QORPERA_PROOF_CHROMIUM:?the pinned Chromium version}
TYPESCRIPT_VERSION=${QORPERA_PROOF_TYPESCRIPT:?the pinned TypeScript version}
TSX_VERSION=${QORPERA_PROOF_TSX:?the pinned tsx version}
UV_VERSION=${QORPERA_PROOF_UV:?the pinned uv version}
MISE_VERSION=${QORPERA_PROOF_MISE:?the pinned mise version}
# What mise installs in the proof: a Node.js other than the image's, from nodejs.org (checked against its SHASUMS256).
MISE_NODE=22.20.0
# The test machine's proxy (test/proof-proxy.py): its bridge forwards nothing, so this machine's downloads, the
# session's Docker pulls among them, go through it. A coding machine on a node has no proxy.
PROXY=${QORPERA_PROOF_PROXY:?the proxy of the test machine}
# The executor's commands for a repository's checks and site: copy.sh, collect.sh and drop.sh.
SCRIPTS=${QORPERA_PROOF_SCRIPTS:?the folder of the executor's commands for a repository's checks and site}
# Docker's official images from their public mirror, which has no pull limit worth the name.
LIBRARY=public.ecr.aws/docker/library
ALPINE=$LIBRARY/alpine:3.22

diagnose() {
	echo "--- failed units"; systemctl --failed --no-pager --plain --no-legend
	echo "--- user@$SESSION_UID.service"; journalctl --no-pager -n 60 -u "user@$SESSION_UID.service"
	echo "--- the session's own journal"; journalctl --no-pager -n 120 "_UID=$SESSION_UID"
}
fail() {
	echo "FAIL: $*" >&2
	diagnose >&2 || true
	exit 1
}
pass() { echo "PASS: $*"; }
# A version line; sed reads to the end, so the tool never writes into a closed pipe.
first() { "$@" 2>&1 | sed -n 1p; }
# One command of the session, as 5g runs it: a transient unit in the session's slice, as its uid, with its walls and
# its environment, from its home (or from SESSION_CWD). (5g also gives each command the session's own network
# namespace: README.md, "What 5g does for each session".)
as_session() {
	systemd-run --quiet --pipe --wait --collect --service-type=exec \
		--uid="$SESSION_UID" --gid="$SESSION_UID" --slice="qorpera-coding-$W32.slice" \
		--property=ProtectProc=invisible --property=PrivateIPC=yes --property="BindPaths=$MOUNT:/company" \
		--working-directory="${SESSION_CWD:-$HOMEDIR}" \
		--setenv=HOME="$HOMEDIR" --setenv=XDG_RUNTIME_DIR="/run/user/$SESSION_UID" \
		--setenv=DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$SESSION_UID/bus" \
		--setenv=DOCKER_HOST="unix:///run/user/$SESSION_UID/docker.sock" \
		--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
		-- "$@"
}

# --- The machine ---------------------------------------------------------------------------------------------------
[[ ! -e /dev/lxd ]] || fail "/dev/lxd is there"
pass "no /dev/lxd"
[[ $(systemctl show -P Result qorpera-grow-root.service) == success ]] || fail "qorpera-grow-root did not succeed"
ROOT=$(findmnt -bno SIZE /)
(( ROOT > 18 * 1024 ** 3 )) || fail "the root is $ROOT bytes, not grown to the 20 GiB disk"
pass "the root file system grew to the disk ($ROOT bytes)"
ADDR4=$(ip -4 -o addr show scope global)
ADDR6=$(ip -6 -o addr show scope global)
[[ -n $ADDR4 && -z $ADDR6 ]] || fail "expected IPv4 by DHCP and no global IPv6: $ADDR4 $ADDR6"
[[ -n $(getent ahostsv4 nodejs.org) ]] || fail "no DNS"
curl -fsS --proxy "$PROXY" -o /dev/null https://nodejs.org/dist/index.json || fail "no HTTPS through $PROXY"
pass "IPv4 by DHCP on its one card, no IPv6, DNS, and HTTPS through the test machine's proxy"
[[ $(hostname) == qorpera-coding ]] || fail "the hostname is $(hostname)"
[[ -e /etc/cloud/cloud-init.disabled && $(cloud-init status 2>&1) == *disabled* ]] || fail "cloud-init is not disabled"
pass "named qorpera-coding, cloud-init disabled"
for unit in apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service; do
	[[ $(systemctl is-enabled "$unit" 2>&1) == masked ]] || fail "$unit is not masked"
done
SNAPD=$(systemctl list-unit-files --no-legend 'snapd*' 2>/dev/null || true)
[[ -z $SNAPD ]] || fail "snapd is there: $SNAPD"
pass "apt's self-update units masked, no snapd"
[[ $(sysctl -n kernel.apparmor_restrict_unprivileged_userns) == 0 ]] || fail "unprivileged user namespaces are restricted"
[[ $(git --version) == "git version $GIT_VERSION" && $(command -v git) == /usr/local/bin/git ]] || fail "git is not $GIT_VERSION"
[[ ! -e /etc/gitconfig ]] || fail "/etc/gitconfig is there"
[[ $(node --version) == "v$NODE_VERSION" ]] || fail "node is not $NODE_VERSION"
[[ $(chromium --version) == *" $CHROMIUM_VERSION"* ]] || fail "chromium is not $CHROMIUM_VERSION"
[[ $(tsc --version) == *"$TYPESCRIPT_VERSION"* && $(first tsx --version) == *"$TSX_VERSION"* ]] ||
	fail "tsc or tsx is not the pinned one: $(tsc --version), $(first tsx --version)"
[[ $(uv --version) == "uv $UV_VERSION"* ]] || fail "uv is not $UV_VERSION: $(uv --version)"
[[ $(mise --version 2>/dev/null) == "$MISE_VERSION"* ]] || fail "mise is not $MISE_VERSION: $(mise --version 2>&1)"
echo "$(python3 --version), $(go version), $(rustc --version), $(first java -version), $(tmux -V)"
echo "$(first gcc --version), $(first clang --version), $(ruby --version), $(first soffice --version)"
echo "$(docker --version), $(docker compose version), $(first docker buildx version)"
pass "git $GIT_VERSION (no system configuration), Node $NODE_VERSION, Chromium $CHROMIUM_VERSION, TypeScript $TYPESCRIPT_VERSION, tsx $TSX_VERSION, uv $UV_VERSION, mise $MISE_VERSION and the toolchains"
[[ -d /opt/qorpera-guest && -d /run/qorpera-folder/mounts && -d /company && -z $(ls -A /company) ]] ||
	fail "the guest agent's place, the mounts' place or an empty /company is missing"
pass "/opt/qorpera-guest, /run/qorpera-folder/mounts and an empty /company"
FAILED=$(systemctl --failed --no-legend --plain)
[[ -z $FAILED ]] || fail "failed units: $FAILED"
pass "no failed unit"
# Both Docker daemons pull through the proxy (runtime drop-ins, gone at the next boot): the system's now, and every
# session's when its user manager starts.
PROXY_ENV=$(printf '[Service]\nEnvironment=HTTP_PROXY=%s HTTPS_PROXY=%s NO_PROXY=localhost,127.0.0.1\n' "$PROXY" "$PROXY")
install -d /run/systemd/system/docker.service.d /run/systemd/user/qorpera-dockerd.service.d
echo "$PROXY_ENV" >/run/systemd/system/docker.service.d/qorpera-proof-proxy.conf
echo "$PROXY_ENV" >/run/systemd/user/qorpera-dockerd.service.d/qorpera-proof-proxy.conf
systemctl daemon-reload
systemctl restart docker.service

# --- One session, as 5g sets it up ---------------------------------------------------------------------------------
# The user: its own group, a login shell (tmux and terminals start it), its home on the machine's disk, and the sudo
# group. useradd hands out no sub-ids of its own: its automatic ranges start at 100000, among the session uids.
getent group qorpera-coding >/dev/null || fail "the image has no group qorpera-coding"
[[ ! -s /etc/subuid && ! -s /etc/subgid ]] || fail "the image has sub-ids already: $(cat /etc/subuid /etc/subgid)"
groupadd -g "$SESSION_UID" "$NAME"
useradd -u "$SESSION_UID" -g "$SESSION_UID" -G qorpera-coding -d "$HOMEDIR" -m -s /bin/bash \
	-K SUB_UID_COUNT=0 -K SUB_GID_COUNT=0 "$NAME"
chmod 0700 "$HOMEDIR"
[[ " $(id -nG "$NAME") " == *" qorpera-coding "* ]] || fail "the session's user is not in qorpera-coding: $(id "$NAME")"
[[ $(stat -c '%u %g %a' "$HOMEDIR") == "$SESSION_UID $SESSION_UID 700" ]] || fail "the home is not the session's alone"
[[ ! -s /etc/subuid && ! -s /etc/subgid ]] || fail "useradd handed out sub-ids: $(cat /etc/subuid /etc/subgid)"
# The sub-ids its rootless Docker maps: the lowest free 65536 from 1048576, above every session uid.
usermod --add-subuids 1048576-1114111 --add-subgids 1048576-1114111 "$NAME"
[[ $(cat /etc/subuid) == "$NAME:1048576:65536" && $(cat /etc/subgid) == "$NAME:1048576:65536" ]] ||
	fail "the sub-ids are not 1048576 to 1114111: $(cat /etc/subuid /etc/subgid)"
# The folder program's mount for the session's worker, stood in for by a plain folder.
install -d -m 0755 "$MOUNT"
echo "company folder $W32" >"$MOUNT/marker"
# The user manager sees the session's /company too, so its rootless Docker binds it; then it starts, and stays.
install -d "/run/systemd/system/user@$SESSION_UID.service.d"
printf '[Service]\nBindPaths=%s:/company\n' "$MOUNT" >"/run/systemd/system/user@$SESSION_UID.service.d/qorpera-company.conf"
systemctl daemon-reload
loginctl enable-linger "$NAME"
for _ in $(seq 1 60); do [[ $(systemctl is-active "user@$SESSION_UID.service") == active ]] && break; sleep 1; done
[[ $(systemctl is-active "user@$SESSION_UID.service") == active ]] || fail "the session's user manager did not start"
MANAGER=$(systemctl show -P MainPID "user@$SESSION_UID.service")
[[ $(cat "/proc/$MANAGER/root/company/marker") == "company folder $W32" ]] || fail "the user manager does not see /company"
CONTROLLERS=$(cat "/sys/fs/cgroup/user.slice/user-$SESSION_UID.slice/user@$SESSION_UID.service/cgroup.controllers")
for controller in cpu cpuset io memory pids; do
	[[ " $CONTROLLERS " == *" $controller "* ]] || fail "the user manager lacks the $controller controller: $CONTROLLERS"
done
pass "session user $NAME in qorpera-coding, its user manager with /company and the controllers $CONTROLLERS"

# --- The session's commands ----------------------------------------------------------------------------------------
[[ $(as_session id -u) == "$SESSION_UID" && $(as_session cat /company/marker) == "company folder $W32" ]] ||
	fail "a session command does not run as $SESSION_UID with /company"
[[ $(as_session sudo -n id -u) == 0 ]] || fail "NOPASSWD sudo does not work"
pass "a command runs as uid $SESSION_UID with /company, and sudo -n gives root without a password"

user_state() { as_session systemctl --user is-active "$1" || true; }
[[ $(user_state qorpera-docker.socket) == active && $(user_state qorpera-dockerd.service) == inactive ]] ||
	fail "before first use the socket should listen and the daemon should not run"
[[ $(stat -c '%u %a' "/run/user/$SESSION_UID/docker.sock") == "$SESSION_UID 600" ]] || fail "the socket is not the session's alone"
INFO=$(as_session docker info --format '{{json .SecurityOptions}} {{.CgroupDriver}} {{.CgroupVersion}} {{.Driver}}')
[[ $INFO == *name=rootless* && $INFO == *" systemd 2 "* ]] || fail "the session's daemon is not rootless with systemd cgroups: $INFO"
[[ $(user_state qorpera-dockerd.service) == active ]] || fail "the rootless daemon is not running after first use"
pass "the rootless daemon started on first use ($INFO)"
SYSTEM=$(as_session sudo docker info --format '{{json .SecurityOptions}}')
[[ $SYSTEM != *rootless* ]] || fail "sudo docker reached a rootless daemon: $SYSTEM"
pass "sudo docker reaches the system daemon ($SYSTEM)"

# A two-service app: a web service built here (BuildKit) that counts hits in Redis, published on a port, and the
# session's /company bound in.
APP=$HOMEDIR/app
install -d -m 0755 -o "$SESSION_UID" -g "$SESSION_UID" "$APP"
cat >"$APP/compose.yaml" <<YAML
services:
  redis:
    image: $LIBRARY/redis:7-alpine
  web:
    build: .
    ports: ["127.0.0.1:8080:8080"]
    depends_on: [redis]
    volumes: ["/company:/company:ro"]
YAML
cat >"$APP/Dockerfile" <<DOCKERFILE
FROM $LIBRARY/python:3.13-alpine
COPY app.py /app.py
CMD ["python", "/app.py"]
DOCKERFILE
cat >"$APP/app.py" <<'PY'
import http.server, socket
def hits():
    with socket.create_connection(("redis", 6379)) as redis:
        redis.sendall(b"*2\r\n$4\r\nINCR\r\n$4\r\nhits\r\n")
        return redis.recv(64).decode().strip().lstrip(":")
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = hits().encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
http.server.ThreadingHTTPServer(("", 8080), Handler).serve_forever()
PY
chown "$SESSION_UID:$SESSION_UID" "$APP/compose.yaml" "$APP/Dockerfile" "$APP/app.py"
# BuildKit asks its client for registry tokens over the build's session, so buildx fetches them itself: the client
# needs the proxy too, not only the daemon.
as_session env HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" NO_PROXY=localhost,127.0.0.1 \
	docker compose --file "$APP/compose.yaml" --project-name proof up --detach --build --quiet-pull ||
	fail "compose up failed"
FIRST=
for _ in $(seq 1 30); do FIRST=$(as_session curl -fsS http://127.0.0.1:8080/ 2>/dev/null) && break; sleep 2; done
SECOND=$(as_session curl -fsS http://127.0.0.1:8080/)
[[ $FIRST == 1 && $SECOND == 2 ]] || fail "the app answered '$FIRST' and '$SECOND', not 1 and 2"
[[ $(as_session docker compose --file "$APP/compose.yaml" --project-name proof exec -T web cat /company/marker) == \
	"company folder $W32" ]] || fail "the container does not see the session's /company"
as_session docker compose --file "$APP/compose.yaml" --project-name proof down --volumes ||
	fail "compose down failed"
pass "compose built and ran redis + web: the published port counted 1 then 2, and the container saw /company"

# docker run -i closes its sending side when stdin ends: the daemon must see it, and still send what comes after.
HALF=$(printf 'hi\n' | as_session timeout 120 docker run -i --rm "$ALPINE" sh -c 'cat; sleep 3; echo late') ||
	fail "docker run -i did not end"
[[ $HALF == $'hi\nlate' ]] || fail "docker run -i gave '$HALF'"
pass "stdin's end reaches the container through the socket, and the output after it still arrives"
LIMITS=$(as_session docker run --rm --memory 64m --cpus 0.5 "$ALPINE" cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max)
[[ $LIMITS == $'67108864\n50000 100000' ]] || fail "container limits are '$LIMITS'"
pass "a rootless container's memory and processor limits hold"
# The system daemon resolves binds in the machine's own mount namespace: /company there is empty, the full path is
# the session's (RUNTIME-FOLDER-CODING-MACHINES.md, "Docker").
[[ -z $(as_session sudo docker run --rm -v /company:/c "$ALPINE" ls -A /c) &&
	$(as_session sudo docker run --rm -v "$MOUNT:/c:ro" "$ALPINE" cat /c/marker) == "company folder $W32" ]] ||
	fail "sudo docker's binds are not the machine's"
pass "sudo docker binds the machine's /company (empty) and the session's full mount path"
# The system daemon, having run containers, turned forwarding on and left the FORWARD policy alone (daemon.json's
# ip-forward-no-drop): a drop there would overrule the accept of each session's own NAT (5g).
[[ $(sysctl -n net.ipv4.ip_forward) == 1 ]] || fail "the system daemon did not turn forwarding on"
POLICY=$(iptables -S FORWARD | sed -n 1p)
[[ $POLICY == "-P FORWARD ACCEPT" ]] || fail "the system daemon set the FORWARD policy: $POLICY"
pass "the system daemon turned forwarding on and left the FORWARD policy at ACCEPT"

DOM=$(as_session timeout 90 chromium --headless --disable-gpu --dump-dom "data:text/html,<p>qorpera-session</p>" 2>/dev/null) ||
	fail "chromium does not start with its sandbox as the session"
[[ $DOM == *qorpera-session* ]] || fail "chromium does not render as the session"
pass "headless Chromium renders as the session with its sandbox on"
TMUX_LIST=$(as_session bash -c 'tmux new-session -d -s proof "sleep 300" && tmux has-session -t proof && tmux list-sessions -F "#{session_name}" && tmux kill-server')
[[ $TMUX_LIST == proof ]] || fail "tmux gave '$TMUX_LIST'"
pass "tmux runs a session"
COMMITS=$(as_session bash -c 'cd "$(mktemp -d)" && git init -q && git -c user.name=proof -c user.email=proof@example.invalid commit -q --allow-empty -m proof && git rev-list --count HEAD')
[[ $COMMITS == 1 ]] || fail "git gave '$COMMITS'"
pass "git $GIT_VERSION commits as the session"

# --- The toolbox and the languages, as the session (the contract's 2026-10-14 amendment, items 7 and 11) -------------
WORK=$HOMEDIR/languages
install -d -m 0755 -o "$SESSION_UID" -g "$SESSION_UID" "$WORK"
cat >"$WORK/hello.ts" <<'TS'
/// <reference lib="dom" />
const greeting: string = "typescript";
console.log(greeting);
TS
printf '#include <stdio.h>\nint main(void) { puts("c"); return 0; }\n' >"$WORK/hello.c"
printf '#include <iostream>\nint main() { std::cout << "c++" << std::endl; }\n' >"$WORK/hello.cpp"
printf 'Qorpera proof\n' >"$WORK/note.txt"
chown "$SESSION_UID:$SESSION_UID" "$WORK/hello.ts" "$WORK/hello.c" "$WORK/hello.cpp" "$WORK/note.txt"
TS_OUT=$(as_session bash -c 'cd ~/languages && tsc --noEmit hello.ts && tsx hello.ts && node hello.ts') ||
	fail "TypeScript failed: $TS_OUT"
[[ $TS_OUT == $'typescript\ntypescript' ]] || fail "TypeScript gave '$TS_OUT'"
pass "tsc checks a TypeScript file, and tsx and node run it"
C_OUT=$(as_session bash -c 'cd ~/languages && gcc -o c-gcc hello.c && ./c-gcc && clang -o c-clang hello.c && ./c-clang &&
	g++ -o cpp-gcc hello.cpp && ./cpp-gcc && clang++ -o cpp-clang hello.cpp && ./cpp-clang') || fail "C or C++ failed: $C_OUT"
[[ $C_OUT == $'c\nc\nc++\nc++' ]] || fail "C and C++ gave '$C_OUT'"
pass "gcc, clang, g++ and clang++ build and run"
RUBY_OUT=$(as_session bash -c 'ruby -e "puts [1, 2, 3].sum" && gem --version >/dev/null && bundle --version >/dev/null') ||
	fail "Ruby failed: $RUBY_OUT"
[[ $RUBY_OUT == 6 ]] || fail "Ruby gave '$RUBY_OUT'"
pass "Ruby runs, with gem and bundler"
# uv makes a project, adds a package from PyPI (through the proxy) and runs it, with the image's Python.
UV_OUT=$(as_session env HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" UV_PYTHON_DOWNLOADS=never bash -c \
	'cd "$(mktemp -d)" && uv init --quiet --bare --name proof && uv add --quiet six && uv run --quiet python -c "import six; print(six.__name__)"') ||
	fail "uv failed: $UV_OUT"
[[ $UV_OUT == six ]] || fail "uv gave '$UV_OUT'"
[[ $(as_session pip --version) == pip* ]] || fail "pip does not answer"
pass "uv adds a package to a project and runs it; pip answers"
# mise installs another Node.js into the user's home, without root.
MISE_OUT=$(as_session env HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" MISE_NODE_GPG_VERIFY=false \
	mise exec "node@$MISE_NODE" -- node --version) || fail "mise failed: $MISE_OUT"
[[ $MISE_OUT == "v$MISE_NODE" && -x $HOMEDIR/.local/share/mise/installs/node/$MISE_NODE/bin/node ]] ||
	fail "mise gave '$MISE_OUT'"
[[ $(stat -c %u "$HOMEDIR/.local/share/mise/installs/node/$MISE_NODE/bin/node") == "$SESSION_UID" ]] ||
	fail "mise's Node is not the session's own"
pass "mise installs Node.js $MISE_NODE in the session's home, as the session"
PDF=$(as_session bash -c 'cd ~/languages && timeout 300 soffice --headless --convert-to pdf --outdir . note.txt >/dev/null 2>&1 &&
	head -c 5 note.pdf') || fail "LibreOffice did not convert"
[[ $PDF == %PDF- ]] || fail "LibreOffice gave '$PDF'"
pass "LibreOffice converts a document to PDF as the session"
TOOLS=$(as_session bash -c 'cd ~/languages && sqlite3 :memory: "select 40 + 2" && zip -q note.zip note.txt && unzip -p note.zip note.txt &&
	rg -c Qorpera note.txt && fd --type f --glob note.txt && jq -n "1 + 1"') || fail "the command-line tools failed: $TOOLS"
[[ $TOOLS == $'42\nQorpera proof\n1\nnote.txt\n2' ]] || fail "the command-line tools gave '$TOOLS'"
pass "sqlite3, zip, unzip, ripgrep, fd and jq work as the session"

# --- A repository's checks and site, as the session (own code storage, steps 3 and 4) -------------------------------
# The executor's own commands, as its runner starts them: each one command of the session's, its text run by bash from
# the run's folder with the run's variables (here bash reads it from a file: systemd-run would expand the $ of an
# argument). A repository's storage in the session's /company holds one commit whose build writes a small website:
# step 3's copy makes the clean copy of it, the build runs there, and step 4's collect takes the site's web files as
# git objects into the storage, which the drop takes away again. Only the image's bash, git and python3 do the work
# (its coreutils are uutils).
install -d -m 0755 /run/qorpera-proof-scripts
install -m 0644 "$SCRIPTS/copy.sh" "$SCRIPTS/collect.sh" "$SCRIPTS/drop.sh" /run/qorpera-proof-scripts/
STORE=$MOUNT/code/proof/site/repo.git
REPO=/company/code/proof/site/repo.git
CHECKS=$HOMEDIR/.qorpera-checks
SOURCE=$(mktemp -d)
cat >"$SOURCE/build.sh" <<'SH'
mkdir -p dist/css dist/.cache
printf '<h1>Proof</h1>\n' >dist/index.html
printf 'body { color: #333; }\n' >dist/css/app.css
printf 'hidden\n' >dist/.cache/x.js
printf 'not served\n' >dist/notes.md
ln -s index.html dist/link.html
SH
git -C "$SOURCE" init -q -b main
git -C "$SOURCE" add build.sh
git -C "$SOURCE" -c user.name=proof -c user.email=proof@example.invalid commit -q -m proof
COMMIT=$(git -C "$SOURCE" rev-parse HEAD)
install -d "$MOUNT/code/proof/site"
git clone -q --bare "$SOURCE" "$STORE"
chown -R "$SESSION_UID:$SESSION_UID" "$MOUNT/code"
# One of the commands as the session: from <cwd>, with the run's variables and the rest; its output (stdout and
# stderr as one, as the guest keeps them) in OUT, its exit code in CODE.
command_as_session() {
	local script=$1 cwd=$2
	shift 2
	CODE=0
	OUT=$(SESSION_CWD=$cwd as_session env QORPERA_CHECKS_ROOT="$CHECKS" QORPERA_CHECKS_REPOSITORY="$REPO" "$@" \
		bash --noprofile --norc "/run/qorpera-proof-scripts/$script" 2>&1) || CODE=$?
}
# One run: its copy, then the build in it as a check runs.
run_copy() {
	command_as_session copy.sh "$HOMEDIR" QORPERA_CHECKS_NAME="$1" QORPERA_CHECKS_COMMIT="$COMMIT"
	[[ $CODE == 0 && -z $OUT ]] || fail "the copy of run $1 gave $CODE: $OUT"
	SESSION_CWD=$CHECKS/$1/src as_session bash build.sh || fail "the build of run $1 failed"
}
collect() { command_as_session collect.sh "$CHECKS/$1/src" QORPERA_CHECKS_NAME="$1" QORPERA_SITE_FOLDER=dist "${@:2}"; }
drop() { command_as_session drop.sh "$CHECKS/$1/src" QORPERA_CHECKS_NAME="$1"; }
store() { git -c safe.directory='*' --git-dir="$STORE" "$@"; }
wrote() { as_session cat "$CHECKS/$1/site.wrote"; }
SITE=$'files 2\nbytes 37'

run_copy 0000000001-0001
[[ $(SESSION_CWD=$CHECKS/0000000001-0001/src as_session git rev-parse HEAD) == "$COMMIT" ]] ||
	fail "the copy is not at the commit"
pass "step 3's copy makes a clean copy of the commit as the session"
collect 0000000001-0001 QORPERA_SITE_SECRET_NAMES=PROOF_SECRET PROOF_SECRET=proof-secret-value-0123
[[ $CODE == 0 && $OUT =~ ^tree\ ([0-9a-f]{40})$'\n'"$SITE"$ ]] || fail "the collect gave $CODE: $OUT"
TREE=${BASH_REMATCH[1]}
WROTE=$(wrote 0000000001-0001)
[[ $(wc -l <<<"$WROTE") == 4 ]] || fail "site.wrote names other than 4 objects: $WROTE"
for id in $WROTE; do [[ -f $STORE/objects/${id:0:2}/${id:2} ]] || fail "$id is not at its name"; done
DIST=$CHECKS/0000000001-0001/src/dist
EXPECTED=$(printf '100644 blob %s\tcss/app.css\n100644 blob %s\tindex.html' \
	"$(git hash-object --no-filters "$DIST/css/app.css")" "$(git hash-object --no-filters "$DIST/index.html")")
[[ $(store ls-tree -r "$TREE") == "$EXPECTED" ]] || fail "the tree holds $(store ls-tree -r "$TREE")"
store fsck --no-dangling --connectivity-only >/dev/null || fail "the storage does not check after the collect"
pass "the collect wrote the site's two web files and two trees into the storage, without its hidden file, other type and link"
drop 0000000001-0001
[[ $CODE == 0 && $OUT == "dropped 4" ]] || fail "the drop gave $CODE: $OUT"
for id in $WROTE; do [[ ! -e $STORE/objects/${id:0:2}/${id:2} ]] || fail "$id is still there"; done
pass "the drop removed the four objects the collect wrote"
run_copy 0000000002-0001
collect 0000000002-0001
[[ $CODE == 0 && $OUT == "tree $TREE"$'\n'"$SITE" && $(wrote 0000000002-0001 | wc -l) == 4 ]] ||
	fail "the collect again gave $CODE: $OUT"
run_copy 0000000003-0001
collect 0000000003-0001
[[ $CODE == 0 && $OUT == "tree $TREE"$'\n'"$SITE" && -z $(wrote 0000000003-0001) ]] ||
	fail "a collect of the same files wrote again: $CODE: $OUT"
pass "a collect of the same files writes no object the storage holds"
as_session mkdir "$CHECKS/0000000009-0001"
collect 0000000003-0001
[[ $CODE == 91 && -z $OUT ]] || fail "a collect of a run that is not the newest gave $CODE: $OUT"
drop 0000000003-0001
[[ $CODE == 91 && -z $OUT ]] || fail "a drop of a run that is not the newest gave $CODE: $OUT"
as_session rmdir "$CHECKS/0000000009-0001"
pass "the collect and the drop of a run that is not the newest exit 91"
SESSION_CWD=$CHECKS/0000000003-0001/src as_session bash -c 'printf "key proof-secret-value-0123\n" >>dist/index.html'
collect 0000000003-0001 QORPERA_SITE_SECRET_NAMES=PROOF_SECRET PROOF_SECRET=proof-secret-value-0123
[[ $CODE == 3 && $OUT == "SITE_HOLDS_SECRET PROOF_SECRET index.html" ]] || fail "a secret in the site gave $CODE: $OUT"
pass "the collect refuses a site that holds a secret value, by its variable and file"
# A page that loads its style from the top of the domain, as the first live site did (11 Nov): a site is served under
# an address of its own, so that link never reaches it.
SESSION_CWD=$CHECKS/0000000003-0001/src as_session bash -c \
	'printf "<link rel=\"stylesheet\" href=\"/css/app.css\">\n" >dist/index.html'
collect 0000000003-0001
[[ $CODE == 3 && $OUT == "SITE_LINKS_FROM_ROOT index.html 1" ]] || fail "a link from the root gave $CODE: $OUT"
pass "the collect refuses a site whose page links from the top of the domain, by its file and how many (never the link)"
as_session rm -r "$CHECKS/0000000003-0001/src/dist"
collect 0000000003-0001
[[ $CODE == 3 && $OUT == SITE_FOLDER_MISSING ]] || fail "a missing folder gave $CODE: $OUT"
pass "the collect refuses a folder that is not there"
echo "ALL PASSED"
