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
PG_IMAGE='docker.io/library/postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3'
NODE_TEST_IMAGE='docker.io/library/node:24-bookworm-slim'
# CI pre-pulls node:22-bookworm-slim for the runtime office probes (--pull=never).
NODE22_TEST_IMAGE='docker.io/library/node:22-bookworm-slim'
# api-front's image (the dbhome kit's docker-compose.dbhome-front.yml), for deploy/sites/envoy-front-sites.test.mjs
# (--pull never; required on a machine whose versions file names it).
ENVOY_TEST_IMAGE='docker.io/envoyproxy/envoy:v1.39.1@sha256:57e14a549d7bd43c8d3f6d03e8cfa653e037d4b38e133acd9b54f38c524401b4'
CODEX_SHA256=9d6a86ec6e280e43d76653d9514aa92769ec67ec157e4ff3bb598fb4a4b48211
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

log "hourly disk, container, volume and cache cleanup (test-machine-tidy) + journald cap"
install -d -m 0755 /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/qorpera-test-machine.conf <<'EOF'
[Journal]
SystemMaxUse=200M
EOF
systemctl restart systemd-journald || true

cat >/usr/local/sbin/qorpera-test-machine-tidy.sh <<'EOF'
#!/bin/bash
set -euo pipefail
HOME_DIR="${QORPERA_TEST_HOME:-/home/tester}"
KEEP_TREES="${QORPERA_TIDY_KEEP_TREES:-12}"
STALE_CONTAINER_AGE_SEC="${QORPERA_TIDY_STALE_CONTAINER_AGE_SEC:-7200}"
HOSTED_CONTAINER_AGE_SEC="${QORPERA_TIDY_HOSTED_CONTAINER_AGE_SEC:-21600}"
RUN_AGE_HOURS="${QORPERA_TIDY_RUN_AGE_HOURS:-24}"
TMP_AGE_MIN="${QORPERA_TIDY_TMP_AGE_MIN:-120}"
BUILDER_UNTIL="${QORPERA_TIDY_BUILDER_UNTIL:-48h}"
JOURNAL_MAX="${QORPERA_TIDY_JOURNAL_MAX:-200M}"
log() { printf '[%s] test-machine-tidy: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
if command -v docker >/dev/null 2>&1; then
	now=$(date +%s)
	removed_ct=0
	reap_older_than() {
		local max_age="$1"
		shift
		local id created ts
		for id in "$@"; do
			[ -n "$id" ] || continue
			created=$(docker inspect -f '{{.Created}}' "$id" 2>/dev/null || true)
			[ -n "$created" ] || continue
			ts=$(date -d "$created" +%s 2>/dev/null || echo "$now")
			if [ $((now - ts)) -gt "$max_age" ]; then
				if docker rm -f -v "$id" >/dev/null 2>&1; then
					removed_ct=$((removed_ct + 1))
				fi
			fi
		done
	}
	mapfile -t short_ids < <(
		{
			docker ps -aq --filter 'name=^cdgateway-' 2>/dev/null || true
			docker ps -aq --filter 'name=^qext-' 2>/dev/null || true
			docker ps -aq --filter 'status=exited' 2>/dev/null || true
		} | sort -u
	)
	mapfile -t hosted_ids < <(
		{
			docker ps -aq --filter 'name=^qorpera-hosted-db-' 2>/dev/null || true
			docker ps -aq --filter 'label=qorpera-run' 2>/dev/null || true
		} | sort -u
	)
	reap_older_than "$STALE_CONTAINER_AGE_SEC" ${short_ids[@]+"${short_ids[@]}"}
	reap_older_than "$HOSTED_CONTAINER_AGE_SEC" ${hosted_ids[@]+"${hosted_ids[@]}"}
	vol_out=$(docker volume prune -f 2>/dev/null | tail -n 1 || true)
	# WHY: Avoid `docker image prune --all` so pinned pre-pulled CI images remain cached on disk.
	img_out=$(docker image prune -f 2>/dev/null | tail -n 1 || true)
	bld_out=$(docker builder prune -f --filter "until=${BUILDER_UNTIL}" 2>/dev/null | tail -n 1 || true)
	log "containers_reaped=${removed_ct} volumes='${vol_out}' images='${img_out}' builder='${bld_out}'"
fi
if [ -d "${HOME_DIR}/runs" ]; then
	cutoff=$(date -u -d "-${RUN_AGE_HOURS} hours" +%Y%m%dT%H%M%S)
	ps_snap=$(ps -ef 2>/dev/null || true)
	removed_runs=0
	for d in "${HOME_DIR}/runs"/*/; do
		[ -d "$d" ] || continue
		n=$(basename "$d")
		if [[ "$n" =~ ^[0-9]{8}T[0-9]{6}- && "${n%%-*}" < "$cutoff" ]]; then
			if ! printf '%s\n' "$ps_snap" | grep -Fq "$n"; then
				rm -rf -- "$d" && removed_runs=$((removed_runs + 1))
			fi
		fi
	done
	log "runs_removed=${removed_runs}"
fi
if [ -d "${HOME_DIR}/trees" ]; then
	removed_trees=0
	while IFS= read -r lock_file; do
		[ -f "$lock_file" ] || continue
		if flock -n "$lock_file" rm -rf -- "${lock_file%.lock}" 2>/dev/null; then
			rm -f -- "$lock_file"
			removed_trees=$((removed_trees + 1))
		fi
	done < <(ls -t "${HOME_DIR}/trees"/*.lock 2>/dev/null | tail -n "+$((KEEP_TREES + 1))" || true)
	for d in "${HOME_DIR}/trees"/*/; do
		[ -d "$d" ] || continue
		base="${d%/}"
		if [ ! -e "${base}.lock" ] && [ -n "$(find "$base" -maxdepth 0 -mmin "+${TMP_AGE_MIN}" 2>/dev/null)" ]; then
			rm -rf -- "$base" && removed_trees=$((removed_trees + 1))
		fi
	done
	log "trees_removed=${removed_trees}"
fi
find /tmp -maxdepth 1 -mindepth 1 -mmin "+${TMP_AGE_MIN}" \
	\( -name 'code-site-*' -o -name 'qorpera-runtime-bundle-test-*' -o -name 'qorpera-bench-*' \) \
	-exec rm -rf -- {} + 2>/dev/null || true
if command -v journalctl >/dev/null 2>&1; then
	journalctl --vacuum-size="$JOURNAL_MAX" >/dev/null 2>&1 || true
fi
avail_root=$(df -Pm / | awk 'NR==2 {print $4}')
avail_tmp=$(df -Pm /tmp | awk 'NR==2 {print $4}')
log "done root_avail_mib=${avail_root} tmp_avail_mib=${avail_tmp}"
EOF
chmod 0755 /usr/local/sbin/qorpera-test-machine-tidy.sh

cat >/etc/systemd/system/test-machine-tidy.service <<'EOF'
[Unit]
Description=Hourly disk, container, volume and cache cleanup (test machine)
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/qorpera-test-machine-tidy.sh
EOF
cat >/etc/systemd/system/test-machine-tidy.timer <<'EOF'
[Unit]
Description=Hourly test machine tidy
[Timer]
OnCalendar=hourly
RandomizedDelaySec=120
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl disable --now test-machine-docker-prune.timer 2>/dev/null || true
rm -f /etc/systemd/system/test-machine-docker-prune.service /etc/systemd/system/test-machine-docker-prune.timer
systemctl daemon-reload
systemctl enable --now test-machine-tidy.timer fstrim.timer

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
# kernel limits and cleanup count one run (until 26 Nov the coding Git sandbox's RLIMIT_NPROC cap of 512
# counted every task of the user; it now counts only the sandbox's). Same trust as tester.
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
