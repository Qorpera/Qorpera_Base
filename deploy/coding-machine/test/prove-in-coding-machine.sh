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
#   repository's storage in the session's /company;
# - the machine's package caches (own code storage, step 6): the guest agent itself (QORPERA_PROOF_GUEST, its source)
#   makes them and two more sessions' users with its mount; the second user installs what the first did with npm, pnpm,
#   pip, uv and Playwright, from the cache, and adds to it; the trim empties the least recently used tool folder;
#   tmpfiles' age removes what was not used.
# Prints PASS lines (and TIME lines: each tool's first and second install), then ALL PASSED.
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
# The guest agent's source: runtime/src (the agent and the two files it imports) and contracts/src, each with a
# package.json, which this machine's Node runs with their types stripped.
GUEST=${QORPERA_PROOF_GUEST:?the folder of the source of the guest agent}
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

# --- The machine's package caches (own code storage, step 6) ---------------------------------------------------------
# The guest agent itself, from its source, makes two more sessions' users with its mount, as it makes every session's:
# the first mount of a boot writes /etc/tmpfiles.d/qorpera-packages.conf, makes the folders and trims them, before the
# user. A stand-in folder program ends as the folder program ends when the node closed the view, so each mount answers
# closed and no user manager starts (none is needed here). Each user's commands run as the guest agent starts one: a
# unit in the session's slice, as its uid and gid, in its network namespace (the mount made it), with exactly the
# environment the executor gives a command (the session's names and the five package caches, read from the source),
# here also the test machine's proxy, and `env -i` where the agent has its relay. pnpm and Playwright are pinned
# versions root installs outside the caches; the lockfiles come from root's own throwaway caches, so the first user
# starts cold. Each project is a few dozen packages: express and typescript for npm and pnpm, requests and rich for pip
# and uv; Playwright's is the headless Chromium.
PACKAGES=/var/cache/qorpera-packages
CONF=/etc/tmpfiles.d/qorpera-packages.conf
[[ ! -e $PACKAGES && ! -e $CONF && ! -e /opt/qorpera-folder ]] ||
	fail "the image has the package caches or a folder program already"
install -d "$GUEST/runtime/node_modules/@qorpera"
ln -s "$GUEST/contracts" "$GUEST/runtime/node_modules/@qorpera/contracts"
AGENT=$GUEST/runtime/src/cloud-coding-guest-agent.ts
install -d -m 0755 /opt/qorpera-folder
printf '#!/bin/sh\nsleep 1\nexit 3\n' >/opt/qorpera-folder/qorpera-folder
chmod 0755 /opt/qorpera-folder/qorpera-folder
CODING_GID=$(getent group qorpera-coding | cut -d: -f3)
FIRST_UID=200002
SECOND_UID=200003
FIRST_W=$(cat /proc/sys/kernel/random/uuid)
SECOND_W=$(cat /proc/sys/kernel/random/uuid)
compact() { printf %s "${1//-/}"; }
guest_mount() {
	printf '{"schema":"qorpera.coding-guest-mount/v1","workerId":"%s","uid":%d,"gid":%d,"view":{"environmentId":"proof","viewId":"proof-%d","pass":"proof-pass"}}' \
		"$1" "$2" "$2" "$2" | node "$AGENT" mount
}
# A folder's access or default ACL as getfacl writes its entries (the image has no getfacl): read from its xattr.
acl() {
	python3 -I - "$1" "$2" <<'PY'
import grp, os, pwd, struct, sys
try:
    raw = os.getxattr(sys.argv[1], "system.posix_acl_" + sys.argv[2])
except OSError:
    print("none")
    sys.exit()
kinds = {1: "user:", 2: "user:", 4: "group:", 8: "group:", 16: "mask:", 32: "other:"}
entries = []
for at in range(4, len(raw), 8):
    tag, perm, qid = struct.unpack("<HHI", raw[at:at + 8])
    who = pwd.getpwuid(qid).pw_name if tag == 2 else grp.getgrgid(qid).gr_name if tag == 8 else ""
    entries.append(kinds[tag] + who + ":" + "".join(c if perm & b else "-" for c, b in (("r", 4), ("w", 2), ("x", 1))))
print(",".join(entries))
PY
}
MOUNTED=$(guest_mount "$FIRST_W" "$FIRST_UID") || fail "the guest agent's mount for $FIRST_UID did not answer"
[[ $MOUNTED == *'"mount":"closed"'* ]] || fail "the guest agent's mount for $FIRST_UID answered $MOUNTED"
[[ $(stat -c '%u %g %a' "$CONF") == "0 0 644" ]] || fail "$CONF is $(stat -c '%u %g %a' "$CONF")"
node --input-type=module -e "import { codingPackageCachesTmpfiles } from '$AGENT'; process.stdout.write(codingPackageCachesTmpfiles('$PACKAGES'));" \
	>"$GUEST/expected.conf"
cmp -s "$CONF" "$GUEST/expected.conf" || fail "$CONF is not the agent's: $(cat "$CONF")"
for folder in "$PACKAGES" "$PACKAGES"/{npm,pnpm,pip,uv,ms-playwright}; do
	[[ $(stat -c '%u %g %a' "$folder") == "0 $CODING_GID 2775" ]] || fail "$folder is $(stat -c '%u %g %a' "$folder")"
	for kind in access default; do
		ACL=$(acl "$folder" "$kind")
		[[ ,$ACL, == *,group:qorpera-coding:rwx,* && ,$ACL, == *,mask::rwx,* ]] || fail "$folder's $kind ACL is $ACL"
	done
done
echo "the tool folders' access ACL: $(acl "$PACKAGES/npm" access); default: $(acl "$PACKAGES/npm" default)"
[[ -f /run/qorpera-guest/packages.ready ]] || fail "the guest agent kept no record of this boot's package caches"
[[ " $(id -nG "qorpera-$FIRST_UID") " == *" qorpera-coding "* ]] || fail "the agent's user is $(id "qorpera-$FIRST_UID")"
[[ $(systemctl is-active systemd-tmpfiles-clean.timer) == active ]] ||
	fail "systemd-tmpfiles-clean.timer is $(systemctl is-active systemd-tmpfiles-clean.timer)"
CONF_INODE=$(stat -c %i "$CONF")
MOUNTED=$(guest_mount "$SECOND_W" "$SECOND_UID") || fail "the guest agent's mount for $SECOND_UID did not answer"
[[ $MOUNTED == *'"mount":"closed"'* ]] || fail "the guest agent's mount for $SECOND_UID answered $MOUNTED"
[[ $(stat -c %i "$CONF") == "$CONF_INODE" ]] || fail "the second mount of the boot wrote $CONF again"
systemctl reset-failed "qorpera-folder-$(compact "$FIRST_W").service" "qorpera-folder-$(compact "$SECOND_W").service" ||
	true
pass "the guest agent's first mount of the boot made $PACKAGES and its five tool folders (root, qorpera-coding, 2775, the group's rwx as access and default ACL) from its tmpfiles file, then the user; the second made neither again; systemd-tmpfiles-clean.timer is active"

# One command of a session, as the guest agent starts it (above).
NETNS=1
mapfile -t CACHES < <(node --input-type=module -e \
	"import { CODING_PACKAGE_CACHE_ENVIRONMENT as e } from '$GUEST/contracts/src/cloud-coding-guest.ts'; for (const [k, v] of Object.entries(e)) console.log(k + '=' + v);")
[[ ${#CACHES[@]} == 5 && ${CACHES[0]} == "npm_config_cache=$PACKAGES/npm" ]] ||
	fail "the package caches' variables read as ${CACHES[*]}"
RESOLV=()
if [[ -e /run/systemd/resolve/resolv.conf ]]; then
	RESOLV=(--property=BindReadOnlyPaths=/run/systemd/resolve/resolv.conf:/etc/resolv.conf)
fi
cached() {
	local uid=$1 w netns=()
	w=$(compact "$2")
	((NETNS == 0)) || netns=(--property="NetworkNamespacePath=/run/netns/qorpera-$w")
	systemd-run --quiet --pipe --wait --collect --service-type=exec --uid="$uid" --gid="$uid" \
		--slice="qorpera-coding-$w.slice" --property=ExitType=cgroup --property=KillMode=control-group \
		--property=TimeoutStopSec=5 --property=ProtectProc=invisible --property=PrivateIPC=yes "${netns[@]}" \
		--property="BindPaths=/run/qorpera-folder/mounts/$w:/company" "${RESOLV[@]}" \
		--working-directory="/home/qorpera-$uid" -- /usr/bin/env -i HOME="/home/qorpera-$uid" USER="qorpera-$uid" \
		LOGNAME="qorpera-$uid" SHELL=/bin/bash PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 \
		TMPDIR=/tmp XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
		DOCKER_HOST="unix:///run/user/$uid/docker.sock" "${CACHES[@]}" HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" \
		NO_PROXY=localhost,127.0.0.1 npm_config_proxy="$PROXY" npm_config_https_proxy="$PROXY" PIP_DISABLE_PIP_VERSION_CHECK=1 \
		UV_PYTHON_DOWNLOADS=never /bin/bash --noprofile --norc -c "$3"
}
IN_UNIT=$(cached "$FIRST_UID" "$FIRST_W" 'id -G')
[[ " $IN_UNIT " == *" $CODING_GID "* ]] ||
	fail "a command unit of $FIRST_UID has the groups '$IN_UNIT', without qorpera-coding ($CODING_GID)"
pass "a command unit started as the guest agent starts one carries the user's supplementary group qorpera-coding ($IN_UNIT)"
if ! cached "$FIRST_UID" "$FIRST_W" 'curl -fsS --max-time 30 -o /dev/null https://registry.npmjs.org/' >/dev/null 2>&1; then
	echo "NOTE: the session's network namespace did not reach the proxy: the package caches' commands run without it"
	NETNS=0
fi
# Root's write through sudo, as a session makes one, and the other session's write into it.
cached "$SECOND_UID" "$SECOND_W" "sudo -n touch $PACKAGES/npm/proof-root-file" ||
	fail "sudo could not write in $PACKAGES/npm"
[[ $(stat -c %u "$PACKAGES/npm/proof-root-file") == 0 ]] || fail "sudo's file is not root's"
cached "$FIRST_UID" "$FIRST_W" "printf more >>$PACKAGES/npm/proof-root-file && rm $PACKAGES/npm/proof-root-file" ||
	fail "a session could not write the file root made in $PACKAGES/npm"
pass "a file root made in the cache through sudo, another session wrote to and removed"

# Root's tools and lockfiles, outside the caches.
KIT=/opt/qorpera-proof-kit
LOCKS=$(mktemp -d -p /root)
ROOT_ENV=(env HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY" npm_config_https_proxy="$PROXY" npm_config_proxy="$PROXY")
for spec in pnpm:pnpm@10.34.9 pnpm12:pnpm@12.18.0 playwright:playwright-core@1.65.0; do
	"${ROOT_ENV[@]}" npm install --prefix "$KIT/${spec%%:*}" --cache "$LOCKS/.npm" --ignore-scripts --no-audit --no-fund \
		--loglevel=error "${spec#*:}" >/dev/null || fail "root could not install ${spec#*:}"
done
PNPM=$KIT/pnpm/node_modules/.bin/pnpm
PNPM12=$KIT/pnpm12/node_modules/.bin/pnpm
PLAYWRIGHT=$KIT/playwright/node_modules/.bin/playwright-core
for tool in npm pnpm pnpm12; do
	install -d "$LOCKS/$tool"
	printf '{"name":"proof","version":"1.0.0","private":true,"dependencies":{"express":"4.21.2","typescript":"5.8.3"}}\n' \
		>"$LOCKS/$tool/package.json"
done
(cd "$LOCKS/npm" && "${ROOT_ENV[@]}" npm install --package-lock-only --ignore-scripts --cache "$LOCKS/.npm" --no-audit \
	--no-fund --loglevel=error >/dev/null) || fail "root could not lock the npm project"
(cd "$LOCKS/pnpm" && "${ROOT_ENV[@]}" "$PNPM" install --lockfile-only --ignore-scripts --store-dir "$LOCKS/.pnpm" \
	>/dev/null) || fail "root could not lock the pnpm project"
[[ -s $LOCKS/npm/package-lock.json && -s $LOCKS/pnpm/pnpm-lock.yaml ]] ||
	fail "a lockfile is missing: $(ls -A "$LOCKS"/*)"
for uid in "$FIRST_UID" "$SECOND_UID"; do
	for tool in npm pnpm pnpm12; do cp -r "$LOCKS/$tool" "/home/qorpera-$uid/proof-$tool"; done
	install -d "/home/qorpera-$uid/proof-pip" "/home/qorpera-$uid/proof-uv"
	chown -R "$uid:$uid" "/home/qorpera-$uid"/proof-*
done

# One command of a user's, timed: it must end 0 and meet no permission error. Its output in OUT, its seconds in TOOK.
DENIED='EACCES|EPERM|permission denied|operation not permitted'
step() {
	local start=${EPOCHREALTIME//[!0-9]/} code=0 tenths
	OUT=$(cached "$2" "$3" "$4" 2>&1) || code=$?
	tenths=$(((${EPOCHREALTIME//[!0-9]/} - start) / 100000))
	TOOK=$((tenths / 10)).$((tenths % 10))
	if ((code != 0)); then
		echo "FAIL: $1 exited $code: $(tail -n 40 <<<"$OUT")" >&2
		return 1
	fi
	if grep -Eiq "$DENIED" <<<"$OUT"; then
		echo "FAIL: $1 met a permission error: $(grep -Ei "$DENIED" <<<"$OUT" | head -n 5)" >&2
		return 1
	fi
}
first() { step "$1 as the first user" "$FIRST_UID" "$FIRST_W" "$2" && FIRST_TOOK=$TOOK; }
second() { step "$1 as the second user" "$SECOND_UID" "$SECOND_W" "$2"; }
# Nothing of the tool in the first user's home: it used its folder of the cache.
kept() {
	[[ -n $(ls -A "$PACKAGES/$1") ]] || { echo "FAIL: nothing in $PACKAGES/$1" >&2 && return 1; }
	[[ ! -e /home/qorpera-$FIRST_UID/$2 ]] || { echo "FAIL: the first user's $2 is there" >&2 && return 1; }
}
prove_npm() {
	local ci='cd ~/proof-npm && npm ci --ignore-scripts --no-audit --no-fund'
	first "npm ci" "$ci" && kept npm .npm/_cacache || return 1
	second "npm ci" "$ci" && SECOND_TOOK=$TOOK || return 1
	second "npm ci --offline" 'cd ~/proof-npm && rm -rf node_modules && npm ci --offline --ignore-scripts --no-audit --no-fund' ||
		return 1
	second "npm install of is-number, which the first did not have" \
		'cd ~/proof-npm && npm install --ignore-scripts --no-audit --no-fund is-number@7.0.0' || return 1
	NOTE="npm ci --offline worked from the cache alone"
}
prove_pnpm() {
	local install="cd ~/proof-pnpm && $PNPM install --frozen-lockfile --ignore-scripts"
	first "pnpm install" "$install" && kept pnpm .local/share/pnpm/store || return 1
	[[ -d $PACKAGES/pnpm/v10 ]] || { echo "FAIL: pnpm's store is not $PACKAGES/pnpm: $(ls -A "$PACKAGES/pnpm")" >&2 && return 1; }
	second "pnpm install" "$install" && SECOND_TOOK=$TOOK || return 1
	second "pnpm install --offline" \
		"cd ~/proof-pnpm && rm -rf node_modules && $PNPM install --frozen-lockfile --offline --ignore-scripts" || return 1
	second "pnpm add of is-number, which the first did not have" \
		"cd ~/proof-pnpm && $PNPM add --ignore-scripts is-number@7.0.0" || return 1
	NOTE="pnpm install --offline worked from the store alone"
}
prove_pip() {
	local install='cd ~/proof-pip && venv/bin/pip install requests==2.32.3 rich==14.0.0'
	step "a venv as the first user" "$FIRST_UID" "$FIRST_W" 'cd ~/proof-pip && python3 -m venv venv' || return 1
	first "pip install" "$install" && kept pip .cache/pip || return 1
	step "a venv as the second user" "$SECOND_UID" "$SECOND_W" 'cd ~/proof-pip && python3 -m venv venv' || return 1
	second "pip install" "$install" && SECOND_TOOK=$TOOK || return 1
	if grep -q "Using cached requests-2.32.3" <<<"$OUT"; then
		NOTE="the second user's pip took the first's download (Using cached)"
	else
		NOTE="the second user's pip downloaded requests again"
	fi
	second "pip install of six, which the first did not have" 'cd ~/proof-pip && venv/bin/pip install six==1.17.0' ||
		return 1
}
prove_uv() {
	local install='cd ~/proof-uv && uv pip install requests==2.32.3 rich==14.0.0'
	step "a venv as the first user" "$FIRST_UID" "$FIRST_W" 'cd ~/proof-uv && uv venv -q' || return 1
	first "uv pip install" "$install" && kept uv .cache/uv || return 1
	step "a venv as the second user" "$SECOND_UID" "$SECOND_W" 'cd ~/proof-uv && uv venv -q' || return 1
	second "uv pip install" "$install" && SECOND_TOOK=$TOOK || return 1
	second "uv pip install --offline" \
		'cd ~/proof-uv && rm -rf .venv && uv venv -q && uv pip install --offline requests==2.32.3 rich==14.0.0' || return 1
	second "uv pip install of six, which the first did not have" 'cd ~/proof-uv && uv pip install six==1.17.0' ||
		return 1
	NOTE="uv pip install --offline worked from the cache alone"
}
prove_playwright() {
	first "playwright install chromium-headless-shell" "$PLAYWRIGHT install chromium-headless-shell" &&
		kept ms-playwright .cache/ms-playwright || return 1
	compgen -G "$PACKAGES/ms-playwright/chromium_headless_shell-*" >/dev/null ||
		{ echo "FAIL: the browser is not in $PACKAGES/ms-playwright" >&2 && return 1; }
	second "playwright install chromium-headless-shell" "$PLAYWRIGHT install chromium-headless-shell" &&
		SECOND_TOOK=$TOOK || return 1
	second "playwright install ffmpeg, which the first did not have" "$PLAYWRIGHT install ffmpeg" || return 1
	NOTE="the second user's install found the first's browser"
}
TOOLS_FAILED=()
for tool in npm pnpm pip uv playwright; do
	NOTE=
	FIRST_TOOK=
	SECOND_TOOK=
	if "prove_$tool"; then
		echo "TIME $tool first ${FIRST_TOOK} s second ${SECOND_TOOK} s"
		pass "$tool: the second user installed what the first did, from the cache, with no permission error (${FIRST_TOOK} s, then ${SECOND_TOOK} s), and added a package; $NOTE"
	else
		TOOLS_FAILED+=("$tool")
	fi
done
# pnpm's newest major, for the report only: where its store goes with these variables, and with pnpm_config_store_dir.
if step "pnpm 12 install" "$FIRST_UID" "$FIRST_W" "cd ~/proof-pnpm12 && $PNPM12 install --ignore-scripts && $PNPM12 store path"; then
	echo "INFO: pnpm 12.18.0 keeps its store at $(tail -n 1 <<<"$OUT")"
else
	echo "INFO: pnpm 12.18.0 did not install"
fi
P12="cd ~/proof-pnpm12 && rm -rf node_modules && export pnpm_config_store_dir=$PACKAGES/pnpm"
if step "pnpm 12 with pnpm_config_store_dir" "$FIRST_UID" "$FIRST_W" "$P12 && $PNPM12 install --ignore-scripts && $PNPM12 store path" &&
	P12_FIRST=$TOOK && P12_STORE=$(tail -n 1 <<<"$OUT") &&
	step "pnpm 12 with pnpm_config_store_dir" "$SECOND_UID" "$SECOND_W" "$P12 && $PNPM12 install --ignore-scripts" &&
	P12_SECOND=$TOOK &&
	step "pnpm 12 add with pnpm_config_store_dir" "$SECOND_UID" "$SECOND_W" "$P12 && $PNPM12 add --ignore-scripts is-number@7.0.0"; then
	echo "INFO: pnpm 12.18.0 with pnpm_config_store_dir: store $P12_STORE; the second user installed from it and added a package ($P12_FIRST s, then $P12_SECOND s)"
else
	echo "INFO: pnpm 12.18.0 with pnpm_config_store_dir did not pass the two users (above)"
fi
echo "INFO: a file the first user's npm wrote: $(find "$PACKAGES/npm/_cacache" -type f -print -quit | xargs stat -c '%u %g %a') $(acl "$(find "$PACKAGES/npm/_cacache" -type f -print -quit)" access)"

# The tool folders' bytes on disk (each inode once), as the trim counts them.
sizes() {
	python3 -I - "$PACKAGES" <<'PY'
import os, stat, sys
seen = set()
for folder in ("npm", "pnpm", "pip", "uv", "ms-playwright"):
    total = 0
    for top, dirs, files in os.walk(os.path.join(sys.argv[1], folder)):
        for name in dirs + files:
            st = os.lstat(os.path.join(top, name))
            if st.st_nlink > 1 and not stat.S_ISDIR(st.st_mode):
                if (st.st_dev, st.st_ino) in seen:
                    continue
                seen.add((st.st_dev, st.st_ino))
            total += st.st_blocks * 512
    print(folder, total)
PY
}
sizes | while read -r folder bytes; do echo "SIZE $folder $((bytes / 1024)) KiB"; done
# The trim, with a limit the folders pass by half of npm's bytes, once npm is the least recently used: every other
# folder's files were read since (touch -a, which changes their change time too).
sleep 2
for folder in pnpm pip uv ms-playwright; do find "$PACKAGES/$folder" -type f -exec touch -a {} +; done
declare -A BYTES
while read -r folder bytes; do BYTES[$folder]=$bytes; done < <(sizes)
LIMIT=$((${BYTES[pnpm]} + ${BYTES[pip]} + ${BYTES[uv]} + ${BYTES[ms-playwright]} + ${BYTES[npm]} / 2))
COUNTS=$(for folder in pnpm pip uv ms-playwright; do find "$PACKAGES/$folder" | wc -l; done)
TRIMMED=$(node --input-type=module -e \
	"import { trimCodingPackageCaches } from '$AGENT'; console.log(JSON.stringify(await trimCodingPackageCaches('$PACKAGES', $LIMIT)));")
[[ $TRIMMED == '["npm"]' ]] || fail "the trim to $LIMIT bytes emptied $TRIMMED"
[[ -z $(ls -A "$PACKAGES/npm") && $(stat -c '%u %g %a' "$PACKAGES/npm") == "0 $CODING_GID 2775" &&
	,$(acl "$PACKAGES/npm" default), == *,group:qorpera-coding:rwx,* ]] || fail "the trim did not leave npm empty and as it was"
[[ $(for folder in pnpm pip uv ms-playwright; do find "$PACKAGES/$folder" | wc -l; done) == "$COUNTS" ]] ||
	fail "the trim changed another folder"
step "npm ci after the trim" "$SECOND_UID" "$SECOND_W" \
	'cd ~/proof-npm && rm -rf node_modules && npm ci --ignore-scripts --no-audit --no-fund' || fail "npm ci failed after the trim"
pass "the trim emptied only the least recently used tool folder (npm) when the folders held more than the limit ($LIMIT bytes); it stayed root's in qorpera-coding with its ACL, and npm ci filled it again"
# The age: the agent's own lines on a scratch folder, with an age of 2 s. A file not used for longer goes; a new one
# stays, and so does each tool folder, old and empty.
AGE=$(mktemp -d -p /root)
sed -e "s#$PACKAGES#$AGE/cache#g" -e 's# 30d$# 2s#' "$CONF" >"$AGE/age.conf"
grep -q "^d $AGE/cache/npm 2775 root qorpera-coding 2s$" "$AGE/age.conf" || fail "the scratch lines are $(cat "$AGE/age.conf")"
systemd-tmpfiles --create "$AGE/age.conf" || fail "systemd-tmpfiles could not make the scratch folders"
install -d "$AGE/cache/npm/_cacache"
printf old >"$AGE/cache/npm/_cacache/old"
printf old >"$AGE/cache/pip/old"
sleep 4
printf new >"$AGE/cache/pip/new"
systemd-tmpfiles --clean "$AGE/age.conf" || fail "systemd-tmpfiles --clean failed"
[[ ! -e $AGE/cache/npm/_cacache/old && ! -e $AGE/cache/pip/old && -e $AGE/cache/pip/new ]] ||
	fail "the age rule left $(find "$AGE/cache" -type f)"
for folder in npm pnpm pip uv ms-playwright; do
	[[ -d $AGE/cache/$folder ]] || fail "the age rule removed the tool folder $folder"
done
pass "tmpfiles' age, on the agent's lines, removed the files not used for longer than it and kept the new one and every tool folder"
((${#TOOLS_FAILED[@]} == 0)) || fail "the two-user proof failed for: ${TOOLS_FAILED[*]} (above)"
echo "ALL PASSED"
