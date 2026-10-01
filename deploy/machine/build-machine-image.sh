#!/bin/bash
# Build the reviewed company machine image on an LXD node (run as root).
#
#   build-machine-image.sh <guest-package-dir> <node-version> <node-linux-x64-tar.xz-sha256> \
#     <build-project> <build-network> <storage-pool> [machines-project]
#
# One image for every machine: Ubuntu 26.04 with rootful Docker Engine and
# Compose, Node, Python 3, Git and build tools, the machine guest helper and
# its watchdog (scripts/package-machine-guest.mjs), and apt's self-update
# units masked. An agent that has a Dockerfile builds and runs it inside its
# machine; images are not made from Dockerfiles.
#
# The builder runs in the node's declared image build space (the observer
# policy's buildSpace: its project and its only network) as a build machine:
# no profiles, its own root disk, the isolation NIC, never autostarting, and
# the builder marker. The observer counts it against that space, so the node
# stays ready while it builds; anywhere else it would be an unregistered
# instance that makes the node unavailable (RUNTIME-HOST-INVENTORY.md). It
# needs 4 CPUs and 8 GiB of the space, so build when the space is empty. A
# build space that shares the default project's images (node 2's does) publishes
# straight into the store the machines project uses; one with its own store
# has the image exported and imported there. The script deletes the builder on
# every exit path.
set -euo pipefail
PACKAGE=${1:?guest package directory}
NODE_VERSION=${2:?Node.js version, for example 24.9.0}
NODE_SHA256=${3:?sha-256 of node-vNODE_VERSION-linux-x64.tar.xz from nodejs.org SHASUMS256.txt}
PROJECT=${4:?the build space project, for example qorpera-build}
NETWORK=${5:?the build space network, for example qorpera0}
POOL=${6:?the storage pool for the builder root, for example qorpera-vm}
MACHINES=${7:-machines}
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
BUILDER="qorpera-machine-build-$STAMP-$$"
ALIAS="qorpera-machine-$STAMP"
lx() { lxc --project "$PROJECT" "$@"; }
# A project without its own images uses the default project's store.
store() { if [[ $(lxc project get "$1" features.images) == true ]]; then echo "$1"; else echo default; fi; }
[[ $PROJECT != "$MACHINES" && $PROJECT != default ]] || { echo "the builder must run in the node's build space, not in $PROJECT" >&2; exit 1; }
lxc project show "$MACHINES" >/dev/null || { echo "no project $MACHINES: create it first (README)" >&2; exit 1; }
IN_SPACE=$(lx list -f csv -c n)
[[ -z $IN_SPACE ]] || { echo "the build space $PROJECT is in use: build when it is empty" >&2; exit 1; }
EXPORT=
cleanup() {
	lx delete --force "$BUILDER" >/dev/null 2>&1 || true
	[[ -z $EXPORT ]] || rm -rf -- "$EXPORT"
}
trap cleanup EXIT

# Made whole in one request, so the observer never sees a half-made builder. Its root is 10 GiB, the smallest machine
# disk: a machine's root can never be smaller than its image.
lx init ubuntu:26.04 "$BUILDER" --vm --no-profiles --storage "$POOL" -d root,size=10GiB -n "$NETWORK" \
	-d eth0,security.mac_filtering=true -d eth0,security.ipv4_filtering=true -d eth0,security.ipv6_filtering=true \
	-d eth0,security.port_isolation=true -c limits.cpu=4 -c limits.memory=8GiB -c boot.mode=uefi-secureboot \
	-c boot.autostart=false -c user.qorpera.image_builder=true -c user.qorpera.purpose=machine-image
lx start "$BUILDER"
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
echo "published $FINGERPRINT (delete it by hand if this build fails from here)" >&2
# Machines are made from the store their project uses. A build space with its own store keeps no copy: export and
# import keep the fingerprint (copying between projects would need LXD to listen on the network).
if [[ $(store "$PROJECT") != "$(store "$MACHINES")" ]]; then
	EXPORT=$(mktemp -d)
	lx image export "$FINGERPRINT" "$EXPORT/image" >/dev/null
	# One file (a published image) or two (metadata and image.root).
	shopt -s nullglob
	PARTS=("$EXPORT"/*)
	if [[ -f $EXPORT/image.root ]]; then
		(( ${#PARTS[@]} == 2 )) || { echo "unexpected export: ${PARTS[*]}" >&2; exit 1; }
		for part in "${PARTS[@]}"; do [[ $part == "$EXPORT/image.root" ]] || META=$part; done
		PARTS=("$META" "$EXPORT/image.root")
	else
		(( ${#PARTS[@]} == 1 )) || { echo "unexpected export: ${PARTS[*]}" >&2; exit 1; }
	fi
	lxc --project "$MACHINES" image import "${PARTS[@]}" --alias "$ALIAS" >/dev/null
	rm -rf -- "$EXPORT"; EXPORT=
	lx image delete "$FINGERPRINT" || echo "the build space still holds $FINGERPRINT: delete it by hand" >&2
fi
[[ $(lxc --project "$MACHINES" image info "$FINGERPRINT" | awk '/^Fingerprint:/ {print $2}') == "$FINGERPRINT" ]] ||
	{ echo "the image is not in the store of project $MACHINES" >&2; exit 1; }
# The bootstrap digest pins exactly what was installed: this script and the guest package.
BOOTSTRAP=$(cat "$0" "$PACKAGE/manifest.json" | sha256sum | cut -d' ' -f1)
jq -n --arg imageFingerprint "$FINGERPRINT" --arg bootstrapSha256 "$BOOTSTRAP" --arg alias "$ALIAS" \
	--arg helperSha256 "$(jq -r '.artifacts[0].sha256' "$PACKAGE/manifest.json")" --arg node "$NODE_VERSION" \
	'{schema: "qorpera.machine-image-build/v1", alias: $alias, imageFingerprint: $imageFingerprint,
	  bootstrapSha256: $bootstrapSha256, helperSha256: $helperSha256, node: $node}' >&3
