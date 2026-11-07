#!/bin/bash
# Runs as root INSIDE a test machine (qorpera-testvm-node02, qorpera-testvm-node01): lxc exec qorpera-testvm-<node>
# --project testmachines -- bash -s -- "<tester public key>" < guest-setup.sh. Idempotent. Changes nothing in LXD's
# view of the VM, so its enrollment digest stays.
# Ubuntu 26.04 + rootful Docker Engine + Node 24 (pinned) + Git/build tools/Python/bubblewrap, no self-update (apt
# units masked, every snap held), user "tester" (docker + sudo) by SSH key only, runner users ci01..ci16, the pinned
# PostgreSQL image, the Node images the *-linux.mjs suites and runtime office probes use and api-front's Envoy image
# (deploy/sites/envoy-front-sites.test.mjs) pre-pulled, LXD 6.9 rev 40424 for nested tests, weekly cleanup of stopped
# containers, dangling images and old build cache.
# Re-running it on a live machine also runs apt-get upgrade, which can restart Docker under running suites.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
TESTER_KEY="${1:?public key for tester}"
PG_IMAGE='docker.io/library/postgres:17.6-alpine3.22@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'
NODE_TEST_IMAGE='docker.io/library/node:24-bookworm-slim'
# CI pre-pulls node:22-bookworm-slim for the runtime office probes (--pull=never).
NODE22_TEST_IMAGE='docker.io/library/node:22-bookworm-slim'
# api-front's image (the dbhome kit's docker-compose.dbhome-front.yml), for deploy/sites/envoy-front-sites.test.mjs
# (--pull never; required on a machine whose versions file names it).
ENVOY_TEST_IMAGE='docker.io/envoyproxy/envoy:v1.39.1@sha256:57e14a549d7bd43c8d3f6d03e8cfa653e037d4b38e133acd9b54f38c524401b4'
CODEX_SHA256=1c08fd015e7fe80bd813cccd73bc4331a01796479df77e16ac202d33ba3b460c
NODE_VERSION=v24.21.0
NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6  # node-v24.21.0-linux-x64.tar.xz, nodejs.org SHASUMS256

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

log "wait for boot"
systemctl is-system-running --wait >/dev/null 2>&1 || true
cloud-init status --wait >/dev/null 2>&1 || true

log "mask apt self-update (before any apt work)"
systemctl stop apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service 2>/dev/null || true
systemctl mask apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service
while pgrep -x 'apt|apt-get|dpkg|unattended-upgr' >/dev/null; do sleep 2; done

log "base packages"
apt-get update -q
apt-get install -yq --no-install-recommends ca-certificates curl gnupg git build-essential python3 python3-venv \
	python3-pip jq rsync unzip zstd xz-utils openssh-server sudo e2fsprogs util-linux psmisc bubblewrap
apt-get -yq upgrade

log "Docker Engine"
. /etc/os-release
if ! command -v dockerd >/dev/null; then
	install -m 0755 -d /etc/apt/keyrings
	curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
	chmod a+r /etc/apt/keyrings/docker.asc
	if curl -fsSI "https://download.docker.com/linux/ubuntu/dists/${VERSION_CODENAME}/Release" >/dev/null; then
		echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" >/etc/apt/sources.list.d/docker.list
		apt-get update -q
		apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
	else
		log "no Docker repo for ${VERSION_CODENAME}; using Ubuntu's docker.io"
		apt-get install -yq docker.io docker-compose-v2 docker-buildx
	fi
fi
systemctl enable --now docker

log "Node ${NODE_VERSION} (pinned tarball and checksum)"
if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
	tmp=$(mktemp -d)
	file="node-${NODE_VERSION}-linux-x64.tar.xz"
	curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${file}" -o "$tmp/${file}"
	echo "${NODE_SHA256}  $tmp/${file}" | sha256sum -c -
	tar -xJf "$tmp/${file}" -C /usr/local --strip-components=1 --no-same-owner
	rm -rf "$tmp"
fi

log "user tester"
id tester >/dev/null 2>&1 || useradd -m -s /bin/bash tester
usermod -aG docker tester
echo 'tester ALL=(ALL) NOPASSWD:ALL' >/etc/sudoers.d/90-tester
chmod 0440 /etc/sudoers.d/90-tester
install -d -m 0700 -o tester -g tester /home/tester/.ssh
printf '%s\n' "$TESTER_KEY" >/home/tester/.ssh/authorized_keys
chown tester:tester /home/tester/.ssh/authorized_keys
chmod 0600 /home/tester/.ssh/authorized_keys
install -d -m 0755 -o tester -g tester /home/tester/runs /home/tester/trees
# sshd keeps the first value it reads, so this file sorts before cloud-init's 50-cloud-init.conf.
cat >/etc/ssh/sshd_config.d/00-test-machine.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers tester
MaxSessions 32
MaxStartups 32:30:64
EOF
rm -f /etc/ssh/sshd_config.d/60-test-machine.conf
# Ubuntu 26.04 starts sshd through ssh.socket: /run/sshd exists only once ssh.service has run, and sshd -t needs it.
install -d -m 0755 /run/sshd
sshd -t
systemctl daemon-reload
if systemctl is-enabled --quiet ssh.socket 2>/dev/null; then
	# Keep socket activation (never enable ssh.service too: both would claim port 22 at boot). A daemon the socket
	# already started gets the new settings; otherwise the next connection starts one with them.
	systemctl try-restart ssh.service
else
	systemctl enable --now ssh.service
	systemctl restart ssh.service
fi

log "pre-pull images"
docker pull -q "$PG_IMAGE"
docker pull -q "$NODE_TEST_IMAGE"
docker pull -q "$NODE22_TEST_IMAGE"
docker pull -q "$ENVOY_TEST_IMAGE"
docker run --rm hello-world >/dev/null

log "weekly Docker cleanup (stopped containers, unused networks, dangling images, build cache older than a week)"
cat >/etc/systemd/system/test-machine-docker-prune.service <<'EOF'
[Unit]
Description=Prune stopped containers, dangling images and old build cache (test machine)
[Service]
Type=oneshot
# No --all: "until" compares an image's build time, not its last use, so --all would delete the pre-pulled
# pinned images. Tagged images stay; only dangling ones go.
ExecStart=/usr/bin/docker system prune --force --filter until=168h
ExecStart=/usr/bin/docker builder prune --force --filter until=168h
EOF
cat >/etc/systemd/system/test-machine-docker-prune.timer <<'EOF'
[Unit]
Description=Weekly Docker prune (test machine)
[Timer]
OnCalendar=weekly
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now test-machine-docker-prune.timer fstrim.timer

log "LXD 6.9 rev 40424 for nested tests; every snap held"
if ! command -v snap >/dev/null; then apt-get install -yq snapd; fi
systemctl start snapd.socket
snap wait system seed.loaded
if snap list lxd >/dev/null 2>&1; then
	[ "$(snap list lxd | awk 'NR==2 {print $3}')" = 40424 ] || snap refresh lxd --channel=6/stable --revision=40424
else
	snap install lxd --channel=6/stable --revision=40424
fi
snap refresh --hold=forever
/snap/bin/lxd waitready --timeout=60
usermod -aG lxd tester

log "runner users ci01..ci16"
# scripts/run-on-node.mjs runs each suite as one of these, locked for the run's duration, so per-user
# kernel limits count one run: the coding Git sandbox caps RLIMIT_NPROC (all tasks of the user) at 512,
# which concurrent runs under the one shared user exhausted together. Same trust as tester.
chmod 0711 /home/tester
runners=$(seq -f 'ci%02g' 1 16 | paste -sd, -)
for runner in ${runners//,/ }; do
	id "$runner" >/dev/null 2>&1 || useradd -m -s /bin/bash "$runner"
	usermod -aG docker,lxd "$runner"
done
sudoers=$(mktemp)
printf 'User_Alias TEST_MACHINE_RUNNERS = %s\nTEST_MACHINE_RUNNERS ALL=(ALL) NOPASSWD:ALL\n' "$runners" >"$sudoers"
visudo -cf "$sudoers"
install -m 0440 -o root -g root "$sudoers" /etc/sudoers.d/91-test-machine-runners
rm -f "$sudoers"

log "the pinned Codex for real-binary tests (QORPERA_CODEX_FENCE_BINARY)"
# Nothing can download it: a patched build. Push it before this script, as deploy/test-machine/README.md says. A machine
# without the right file stays not set up, so no run lands on it; scripts/run-on-node.test.mjs ties this hash to the pin in
# deploy/first-node/native-codex/guest-package-manifest.json.
echo "${CODEX_SHA256}  /opt/qorpera-codex-fence/codex" | sha256sum -c - || {
	log "/opt/qorpera-codex-fence/codex is missing or not the pinned build: push it (deploy/test-machine/README.md), then run this again"
	exit 1
}

log "the CPU lane's kept slot (5): its lock file root's and read-only"
# scripts/run-on-node.mjs keeps slot 5 for --front runs and opens a slot's lock file for reading where it can. A client
# from before that change opens it for writing, so it skips the slot once the file is root's. Changed in place: a run
# that holds its lock keeps it. /run/lock is a tmpfs, so tmpfiles.d makes the file again at every boot.
kept=/run/lock/qorpera-test-machine-slot5.lock
echo "f $kept 0644 root root -" >/etc/tmpfiles.d/qorpera-test-machine.conf
if [ -e "$kept" ]; then chown root:root "$kept"; chmod 0644 "$kept"; else systemd-tmpfiles --create /etc/tmpfiles.d/qorpera-test-machine.conf; fi

log "versions"
{
	echo "os=$(. /etc/os-release; echo "$PRETTY_NAME")"
	echo "kernel=$(uname -r)"
	echo "node=$(/usr/local/bin/node --version)"
	echo "npm=$(/usr/local/bin/npm --version)"
	echo "docker=$(docker version --format '{{.Server.Version}}')"
	echo "git=$(git --version | awk '{print $3}')"
	echo "python=$(python3 --version | awk '{print $2}')"
	echo "lxd=$(snap list lxd | awk 'NR==2 {print $2":"$3}')"
	echo "snaps_held=$(snap refresh --time 2>/dev/null | awk -F': ' '/^hold/ {print $2}')"
	echo "postgres_image=$(docker image inspect --format '{{index .RepoDigests 0}}' "$PG_IMAGE")"
	echo "node_test_image=$(docker image inspect --format '{{index .RepoDigests 0}}' "$NODE_TEST_IMAGE")"
	echo "node22_test_image=$(docker image inspect --format '{{index .RepoDigests 0}}' "$NODE22_TEST_IMAGE")"
	echo "envoy_test_image=$(docker image inspect --format '{{index .RepoDigests 0}}' "$ENVOY_TEST_IMAGE")"
	echo "bwrap=$(bwrap --version)"
	echo "codex_fence_sha256=${CODEX_SHA256}"
	echo "runners=$(getent passwd | awk -F: '/^ci[0-9][0-9]:/ {print $1}' | paste -sd, -)"
	echo "cpus=$(nproc) mem_kib=$(awk '/MemTotal/{print $2}' /proc/meminfo)"
	echo "kvm_device=$(test -c /dev/kvm && echo present || echo absent)"
	echo "cpu_virt_flags=$(grep -cE 'vmx|svm' /proc/cpuinfo)"
	for u in apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service; do
		echo "$u=$(systemctl is-enabled "$u" 2>/dev/null || true)"
	done
} | tee /etc/qorpera-test-machine-versions
