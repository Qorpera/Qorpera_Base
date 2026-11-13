#!/usr/bin/env bash
# Installs node 1's door of members' live pictures (README.md) from a checkout of this folder: verifies every file
# against the pins below, installs the door (/usr/local/sbin/qorpera-screens-door), the operator's sudoers line for
# its four verbs, the tunnel's connector (cloudflared, pinned) and its unit, and leaves the unit OFF: not enabled, not
# started. No token is read, written or asked for here: that is the door's own `token` step, Jonas's, at the release.
set -euo pipefail
umask 022

EXPECTED_DOOR_SHA256="b96b484a13ae86d43526c62f8a98fae7ec91a6a15f3b7c80c7f9e41ca1b48375"
EXPECTED_UNIT_SHA256="e074286471c87a0109e93ab4f5327b33d8ba55b0b693349e807e65a8243b16cb"
EXPECTED_SUDOERS_SHA256="cefc3111c28a7875f8acb47650764b2d8e88ac54dca833a2ad58bcfdf00bc3bf"
# cloudflared-linux-amd64 2026.10.5 (40,263,303 bytes) from
# https://github.com/cloudflare/cloudflared/releases/download/2026.10.5/cloudflared-linux-amd64: the sha-256 GitHub states
# for that asset (read 13 Nov 2026). The file fetched for node 1 at the release must be exactly it, or nothing installs.
CLOUDFLARED_VERSION="2026.10.5"
EXPECTED_CLOUDFLARED_SHA256="e1bc0cf084fd9e590554fe769a86b1db46701c3f847a43d902f7b974a4e16298"
SOURCE_ROOT=$(cd "$(dirname "$0")" && pwd)
UNIT_PATH=/usr/local/lib/systemd/system/qorpera-screens-tunnel.service

operator=""
cloudflared=""
while [[ $# -gt 0 ]]; do
	case "$1" in
	--operator)
		operator=$2
		shift 2
		;;
	--cloudflared)
		cloudflared=$2
		shift 2
		;;
	*)
		echo "Usage: $0 --operator <the node's admin user> --cloudflared <cloudflared-linux-amd64 ${CLOUDFLARED_VERSION}>" >&2
		exit 64
		;;
	esac
done

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script as root." >&2
	exit 1
fi
if [[ ! ${operator} =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || ! id -u -- "${operator}" >/dev/null 2>&1; then
	echo "--operator must name a user of this host." >&2
	exit 64
fi

verify_sha256() {
	local file=$1
	local expected=$2
	if [[ ! ${expected} =~ ^[0-9a-f]{64}$ ]]; then
		echo "No pin for ${file}; nothing installed." >&2
		exit 1
	fi
	if [[ ! -f ${file} || -L ${file} ]]; then
		echo "Missing or unsafe file: ${file}" >&2
		exit 1
	fi
	if [[ $(sha256sum "${file}" | awk '{ print $1 }') != "${expected}" ]]; then
		echo "Checksum mismatch for ${file}." >&2
		exit 1
	fi
}

verify_sha256 "${SOURCE_ROOT}/qorpera-screens-door" "${EXPECTED_DOOR_SHA256}"
verify_sha256 "${SOURCE_ROOT}/qorpera-screens-tunnel.service" "${EXPECTED_UNIT_SHA256}"
verify_sha256 "${SOURCE_ROOT}/qorpera-screens-door.sudoers" "${EXPECTED_SUDOERS_SHA256}"
verify_sha256 "${cloudflared}" "${EXPECTED_CLOUDFLARED_SHA256}"

install -o root -g root -m 0755 "${cloudflared}" /usr/local/bin/cloudflared.new
mv -f /usr/local/bin/cloudflared.new /usr/local/bin/cloudflared
install -o root -g root -m 0755 "${SOURCE_ROOT}/qorpera-screens-door" /usr/local/sbin/qorpera-screens-door
sudoers=$(mktemp)
trap 'rm -f -- "${sudoers}"' EXIT
sed "s/^OPERATOR /${operator} /" "${SOURCE_ROOT}/qorpera-screens-door.sudoers" >"${sudoers}"
visudo -cqf "${sudoers}"
install -o root -g root -m 0440 "${sudoers}" /etc/sudoers.d/qorpera-screens-door
# The unit lives where `systemctl mask` (the door's off) can still mask it: not under /etc/systemd/system.
install -d -o root -g root -m 0755 /usr/local/lib/systemd/system
install -o root -g root -m 0644 "${SOURCE_ROOT}/qorpera-screens-tunnel.service" "${UNIT_PATH}"
systemctl daemon-reload
echo "Installed, off: the unit is neither enabled nor started. Next (Jonas): sudo -n qorpera-screens-door token, then on."
