#!/usr/bin/env bash
# Installs the node tidy-up from a checkout of this folder: verifies every file against the pins below,
# installs the node's config when given, runs a dry run (a refusal or an error stops the install), installs
# the unit and timer, and enables the timer only with --enable-timer, after the dry run has been reviewed.
set -euo pipefail

EXPECTED_TOOL_SHA256="22ef41e2a4d2e11ef2b3f8ee030d828c33bb06c013ce6fa050459ef93decfe0f"
EXPECTED_UNIT_SHA256="5c8e99b846d5651a650420c84dcb42b8c4f5d26e7b4528545e0d8a7b8f4a280b"
EXPECTED_TIMER_SHA256="7827685e6e78a16eeec690c23429b1ba778ca825de5521c570efea245dbe2aa4"
SOURCE_ROOT=$(cd "$(dirname "$0")" && pwd)
INSTALL_ROOT="/opt/qorpera-node-tidy"
CONFIG_PATH="/etc/qorpera-node-tidy.json"

config=""
enable_timer=0
while [[ $# -gt 0 ]]; do
	case "$1" in
	--config)
		config=$2
		shift 2
		;;
	--enable-timer)
		enable_timer=1
		shift
		;;
	*)
		echo "Usage: $0 [--config <node config json>] [--enable-timer]" >&2
		exit 64
		;;
	esac
done

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script as root." >&2
	exit 1
fi

verify_sha256() {
	local file=$1
	local expected=$2
	if [[ ! -f ${file} || -L ${file} ]]; then
		echo "Missing or unsafe file: ${file}" >&2
		exit 1
	fi
	if [[ $(sha256sum "${file}" | awk '{ print $1 }') != "${expected}" ]]; then
		echo "Checksum mismatch for ${file}." >&2
		exit 1
	fi
}

verify_sha256 "${SOURCE_ROOT}/qorpera-node-tidy.mjs" "${EXPECTED_TOOL_SHA256}"
verify_sha256 "${SOURCE_ROOT}/qorpera-node-tidy.service" "${EXPECTED_UNIT_SHA256}"
verify_sha256 "${SOURCE_ROOT}/qorpera-node-tidy.timer" "${EXPECTED_TIMER_SHA256}"

install -d -o root -g root -m 0755 "${INSTALL_ROOT}"
install -o root -g root -m 0444 "${SOURCE_ROOT}/qorpera-node-tidy.mjs" "${INSTALL_ROOT}/qorpera-node-tidy.mjs"
if [[ -n ${config} ]]; then
	install -o root -g root -m 0444 "${config}" "${CONFIG_PATH}"
fi
if [[ ! -f ${CONFIG_PATH} ]]; then
	echo "${CONFIG_PATH} is missing; pass --config with the node's configuration." >&2
	exit 1
fi

echo "Dry run:"
/usr/bin/node "${INSTALL_ROOT}/qorpera-node-tidy.mjs" --config "${CONFIG_PATH}"

install -o root -g root -m 0644 "${SOURCE_ROOT}/qorpera-node-tidy.service" /etc/systemd/system/qorpera-node-tidy.service
install -o root -g root -m 0644 "${SOURCE_ROOT}/qorpera-node-tidy.timer" /etc/systemd/system/qorpera-node-tidy.timer
systemctl daemon-reload
if [[ ${enable_timer} -eq 1 ]]; then
	systemctl enable --now qorpera-node-tidy.timer
else
	echo "Unit and timer installed, timer not enabled. Review the dry run, then rerun with --enable-timer."
fi
