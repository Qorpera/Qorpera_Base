#!/bin/bash
# Build the reviewed company machine image on an LXD node (run as root).
#
#   build-machine-image.sh <guest-package-dir> <node-version> <node-linux-x64-tar.xz-sha256> [project] [network]
#
# One image for every machine: Ubuntu 26.04 with rootful Docker Engine and
# Compose, Node, Python 3, Git and build tools, the machine guest helper and
# its watchdog (scripts/package-machine-guest.mjs), and apt's self-update
# units masked. An agent that has a Dockerfile builds and runs it inside its
# machine; images are not made from Dockerfiles.
#
# The builder is an ordinary VM in the machines project. Until it is deleted
# it is an unregistered instance, so the node's observer reports the node
# unavailable (RUNTIME-HOST-INVENTORY.md): build in a quiet window, or on a
# node that serves nobody at that moment. The script deletes the builder on
# every exit path.
set -euo pipefail
PACKAGE=${1:?guest package directory}
NODE_VERSION=${2:?Node.js version, for example 24.9.0}
NODE_SHA256=${3:?sha-256 of node-vNODE_VERSION-linux-x64.tar.xz from nodejs.org SHASUMS256.txt}
PROJECT=${4:-machines}
NETWORK=${5:-machine-net}
[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
# Only the build record goes to stdout (> image-build.json); the builder's own output goes to stderr.
exec 3>&1 1>&2
[[ $NODE_VERSION =~ ^2[4-9]\.[0-9]+\.[0-9]+$ ]] || { echo "invalid Node.js version" >&2; exit 1; }
[[ $NODE_SHA256 =~ ^[0-9a-f]{64}$ ]] || { echo "invalid Node.js sha-256" >&2; exit 1; }
for file in cloud-machine-guest.mjs qorpera-machine.slice qorpera-machine-watchdog.service qorpera-machine-watchdog.timer manifest.json; do
	[[ -f $PACKAGE/$file ]] || { echo "package misses $file" >&2; exit 1; }
done
# The package's own checksums, before anything is installed.
python3 - "$PACKAGE" <<'PY'
import hashlib, json, sys, pathlib
root = pathlib.Path(sys.argv[1])
for artifact in json.loads((root / "manifest.json").read_text())["artifacts"]:
    if hashlib.sha256((root / artifact["file"]).read_bytes()).hexdigest() != artifact["sha256"]:
        sys.exit(f"checksum differs: {artifact['file']}")
PY

STAMP=$(date -u +%Y%m%d%H%M%S)
BUILDER="qorpera-machine-build-$STAMP"
ALIAS="qorpera-machine-$STAMP"
lx() { lxc --project "$PROJECT" "$@"; }
cleanup() { lx delete --force "$BUILDER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

lx launch ubuntu:26.04 "$BUILDER" --vm -c limits.cpu=4 -c limits.memory=8GiB -c boot.mode=uefi-secureboot -n "$NETWORK"
for _ in $(seq 1 90); do lx exec "$BUILDER" -- true >/dev/null 2>&1 && break; sleep 2; done
lx exec "$BUILDER" -- cloud-init status --wait >/dev/null
lx exec "$BUILDER" -- env NODE_VERSION="$NODE_VERSION" NODE_SHA256="$NODE_SHA256" bash -euo pipefail -c '
	export DEBIAN_FRONTEND=noninteractive
	apt-get update
	apt-get install -y --no-install-recommends ca-certificates curl git jq unzip xz-utils make pkg-config \
		build-essential python3 python3-venv python3-pip docker.io docker-compose-v2 docker-buildx
	curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
	echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -
	tar -xJf /tmp/node.tar.xz -C /opt
	ln -sfn "/opt/node-v${NODE_VERSION}-linux-x64" /opt/node
	for tool in node npm npx corepack; do ln -sf "/opt/node/bin/$tool" "/usr/local/bin/$tool"; done
	ln -sf /opt/node/bin/node /usr/bin/node
	rm -f /tmp/node.tar.xz
	systemctl enable docker.service containerd.service
	install -d -o root -g root -m 0755 /opt/qorpera-machine
	# No self-update: the image stays what was reviewed; agents update what they need inside their own machine.
	systemctl mask apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service
'
lx file push "$PACKAGE/cloud-machine-guest.mjs" "$BUILDER/opt/qorpera-machine/cloud-machine-guest.mjs" --uid 0 --gid 0 --mode 0444
for unit in qorpera-machine.slice qorpera-machine-watchdog.service qorpera-machine-watchdog.timer; do
	lx file push "$PACKAGE/$unit" "$BUILDER/etc/systemd/system/$unit" --uid 0 --gid 0 --mode 0644
done
lx exec "$BUILDER" -- bash -euo pipefail -c '
	systemctl daemon-reload
	systemctl enable qorpera-machine-watchdog.timer
	# Checks the reviewed image must pass.
	docker --version && docker compose version && docker buildx version
	node --version | grep -q "^v2[4-9]\."
	python3 --version && git --version && gcc --version | head -1
	for unit in apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service; do
		[[ $(readlink "/etc/systemd/system/$unit") == /dev/null ]]
	done
	systemd-analyze verify /etc/systemd/system/qorpera-machine-watchdog.service /etc/systemd/system/qorpera-machine.slice
	# Nothing of this build stays: logs, keys, caches, the machine id.
	apt-get clean
	rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /root/.cache /root/.npm
	cloud-init clean --logs --machine-id
	rm -f /etc/ssh/ssh_host_*
	journalctl --rotate --vacuum-time=1s >/dev/null 2>&1 || true
	sync
'
lx stop "$BUILDER"
lx publish "$BUILDER" --alias "$ALIAS" description="Qorpera company machine $STAMP (Ubuntu 26.04, Docker, Node $NODE_VERSION)"
FINGERPRINT=$(lx image info "$ALIAS" | awk '/^Fingerprint:/ {print $2}')
[[ $FINGERPRINT =~ ^[0-9a-f]{64}$ ]] || { echo "no image fingerprint" >&2; exit 1; }
# The bootstrap digest pins exactly what was installed: this script and the guest package.
BOOTSTRAP=$(cat "$0" "$PACKAGE/manifest.json" | sha256sum | cut -d' ' -f1)
jq -n --arg imageFingerprint "$FINGERPRINT" --arg bootstrapSha256 "$BOOTSTRAP" --arg alias "$ALIAS" \
	--arg helperSha256 "$(jq -r '.artifacts[0].sha256' "$PACKAGE/manifest.json")" --arg node "$NODE_VERSION" \
	'{schema: "qorpera.machine-image-build/v1", alias: $alias, imageFingerprint: $imageFingerprint,
	  bootstrapSha256: $bootstrapSha256, helperSha256: $helperSha256, node: $node}' >&3
