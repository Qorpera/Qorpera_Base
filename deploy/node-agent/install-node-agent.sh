#!/usr/bin/env bash
# Installs the node agent and the fixed launcher from a checkout of this folder, verifying both against the pins
# below, and enrolls the release public key after checking it against the sha256 recorded in the bundle registry.
# The key joins the release-key set as /usr/share/qorpera/release-keys/<key id>.pem (README.md "Release keys"); the
# legacy key file is written only when there is none, so enrolling a second key never replaces the first.
# It changes no unit and restarts nothing: moving roles onto the new units is the separate migration step.
set -euo pipefail

EXPECTED_AGENT_SHA256="3b49c0c79ab58be29475821a44458d628e9e535fda856c1e306ac22d36025446"
EXPECTED_MIGRATE_SHA256="77a523e8bd61e36957f420c5f1bdf6396b25795ebde38e80ab1c27ba36a02b17"
EXPECTED_LAUNCHER_SHA256="430812c2a5481c4f0a6e933a70c0c5b9bca4c0c58395deac0ac7bc230435dce2"
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

# Verify root-only copies and install exactly those: the source paths are not re-read after the check.
staging=$(mktemp -d)
trap 'rm -rf "${staging}"' EXIT
install -m 0400 "${SOURCE_ROOT}/qorpera-node-agent.mjs" "${staging}/qorpera-node-agent.mjs"
install -m 0400 "${SOURCE_ROOT}/qorpera-node-launch.py" "${staging}/qorpera-node-launch.py"
install -m 0400 "${SOURCE_ROOT}/qorpera-node-migrate.py" "${staging}/qorpera-node-migrate.py"
install -m 0400 "${release_key}" "${staging}/release.pem"
verify_sha256 "${staging}/qorpera-node-agent.mjs" "${EXPECTED_AGENT_SHA256}"
verify_sha256 "${staging}/qorpera-node-launch.py" "${EXPECTED_LAUNCHER_SHA256}"
verify_sha256 "${staging}/qorpera-node-migrate.py" "${EXPECTED_MIGRATE_SHA256}"
verify_sha256 "${staging}/release.pem" "${release_key_sha256}"

# The agent reads only an Ed25519 public key in the one PEM form openssl writes, and names it by the first 16 hex
# characters of sha256 over its SPKI DER.
if ! openssl pkey -pubin -in "${staging}/release.pem" 2>/dev/null | cmp -s - "${staging}/release.pem"; then
	echo "The release key is not a public key PEM in its plain form." >&2
	exit 1
fi
key_der=$(openssl pkey -pubin -in "${staging}/release.pem" -outform DER | od -An -v -tx1 | tr -d ' \n')
if [[ ! ${key_der} =~ ^302a300506032b6570032100[0-9a-f]{64}$ ]]; then
	echo "The release key is not an Ed25519 key." >&2
	exit 1
fi
key_id=$(openssl pkey -pubin -in "${staging}/release.pem" -outform DER | sha256sum | cut -c1-16)
release_keys=/usr/share/qorpera/release-keys
if [[ -d ${release_keys} && ! -e ${release_keys}/${key_id}.pem ]] &&
	[[ $(find "${release_keys}" -mindepth 1 -maxdepth 1 | wc -l) -ge 8 ]]; then
	echo "The release-key set already holds 8 keys; drop one before adding another." >&2
	exit 1
fi

install -d -o root -g root -m 0755 /opt/qorpera-node /opt/qorpera-node/agent /opt/qorpera-node/releases /opt/qorpera-node/roles
install -d -o root -g root -m 0755 /usr/local/libexec/qorpera-node /etc/qorpera-node /etc/qorpera-node/keys
install -d -o root -g root -m 0755 /usr/share/qorpera "${release_keys}"
install -d -o root -g root -m 0700 /var/lib/qorpera-node-agent
install -o root -g root -m 0444 "${staging}/qorpera-node-agent.mjs" /opt/qorpera-node/agent/qorpera-node-agent.mjs
install -o root -g root -m 0444 "${staging}/qorpera-node-launch.py" /usr/local/libexec/qorpera-node/qorpera-node-launch.py
install -o root -g root -m 0444 "${staging}/qorpera-node-migrate.py" /usr/local/libexec/qorpera-node/qorpera-node-migrate.py
install -o root -g root -m 0444 "${staging}/release.pem" "${release_keys}/${key_id}.pem"
if [[ ! -e /etc/qorpera-node/keys/release.pem && ! -L /etc/qorpera-node/keys/release.pem ]]; then
	install -o root -g root -m 0444 "${staging}/release.pem" /etc/qorpera-node/keys/release.pem
fi
echo "Node agent and launcher installed, release key ${key_id} enrolled; no unit changed."
