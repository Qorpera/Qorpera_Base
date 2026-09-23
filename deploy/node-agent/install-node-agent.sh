#!/usr/bin/env bash
# Installs the node agent and the fixed launcher from a checkout of this folder, verifying both against the pins
# below, and enrolls the release public key after checking it against the sha256 recorded in the bundle registry.
# It changes no unit and restarts nothing: moving roles onto the new units is the separate migration step.
set -euo pipefail

EXPECTED_AGENT_SHA256="9005979e739ed66d538f202517c2c3dee2437e005c042073a555f5ff0c347923"
EXPECTED_LAUNCHER_SHA256="202e7aa6110e37f1e1578686a84cfd7c56e10d12d8a38f9ed279a9471030fb4f"
SOURCE_ROOT=$(cd "$(dirname "$0")" && pwd)

release_key=""
release_key_sha256=""
while [[ $# -gt 0 ]]; do
	case "$1" in
	--release-key)
		release_key=$2
		shift 2
		;;
	--release-key-sha256)
		release_key_sha256=$2
		shift 2
		;;
	*)
		echo "Usage: $0 --release-key <public key PEM> --release-key-sha256 <hex>" >&2
		exit 64
		;;
	esac
done

if [[ ${EUID} -ne 0 ]]; then
	echo "Run this script as root." >&2
	exit 1
fi
if [[ -z ${release_key} || ! ${release_key_sha256} =~ ^[0-9a-f]{64}$ ]]; then
	echo "Pass the release public key and its registry sha256." >&2
	exit 64
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

verify_sha256 "${SOURCE_ROOT}/qorpera-node-agent.mjs" "${EXPECTED_AGENT_SHA256}"
verify_sha256 "${SOURCE_ROOT}/qorpera-node-launch.py" "${EXPECTED_LAUNCHER_SHA256}"
verify_sha256 "${release_key}" "${release_key_sha256}"

install -d -o root -g root -m 0755 /opt/qorpera-node /opt/qorpera-node/agent /opt/qorpera-node/releases
install -d -o root -g root -m 0755 /usr/local/libexec/qorpera-node /etc/qorpera-node /etc/qorpera-node/keys
install -d -o root -g root -m 0700 /var/lib/qorpera-node-agent
install -o root -g root -m 0444 "${SOURCE_ROOT}/qorpera-node-agent.mjs" /opt/qorpera-node/agent/qorpera-node-agent.mjs
install -o root -g root -m 0444 "${SOURCE_ROOT}/qorpera-node-launch.py" /usr/local/libexec/qorpera-node/qorpera-node-launch.py
install -o root -g root -m 0444 "${release_key}" /etc/qorpera-node/keys/release.pem
echo "Node agent and launcher installed; no unit changed."
